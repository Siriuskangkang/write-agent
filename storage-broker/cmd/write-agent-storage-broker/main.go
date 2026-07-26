package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"write-agent/storage-broker/internal/contract"
	"write-agent/storage-broker/internal/fsstore"
	"write-agent/storage-broker/internal/mysqlstore"
)

type authorityStore interface {
	Claim(context.Context, string, uint32, string) (*contract.Intent, error)
	Complete(
		context.Context,
		contract.Intent,
		contract.Outcome,
		string,
	) error
}

type fileStore interface {
	Execute(context.Context, contract.Intent) contract.Outcome
}

type config struct {
	dsn            string
	protectedRoot  string
	quarantineRoot string
	instanceID     string
	epoch          string
	leaseSeconds   uint32
	pollInterval   time.Duration
}

func main() {
	if err := runMain(); err != nil {
		log.Print("storage broker stopped")
		os.Exit(1)
	}
}

func runMain() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	db, err := sql.Open("mysql", cfg.dsn)
	if err != nil {
		return errors.New("storage database configuration is invalid")
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return errors.New("storage database is unavailable")
	}
	files, err := fsstore.New(cfg.protectedRoot, cfg.quarantineRoot)
	if err != nil {
		return errors.New("storage roots are unavailable")
	}
	defer files.Close()

	return runBroker(
		ctx,
		mysqlstore.New(db),
		files,
		cfg.instanceID,
		cfg.leaseSeconds,
		cfg.epoch,
		cfg.pollInterval,
	)
}

func runBroker(
	ctx context.Context,
	authority authorityStore,
	files fileStore,
	instanceID string,
	leaseSeconds uint32,
	epoch string,
	pollInterval time.Duration,
) error {
	for {
		claim, err := authority.Claim(
			ctx,
			instanceID,
			leaseSeconds,
			epoch,
		)
		if errors.Is(err, mysqlstore.ErrNoWork) {
			if !waitOrDone(ctx, pollInterval) {
				return nil
			}
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("storage claim failed")
		}
		outcome := files.Execute(ctx, *claim)
		if err := authority.Complete(
			ctx,
			*claim,
			outcome,
			epoch,
		); err != nil {
			log.Printf(
				"storage completion failed intent_id=%s result_code=%s",
				claim.IntentID,
				outcome.Code,
			)
		}
		if ctx.Err() != nil {
			return nil
		}
	}
}

func waitOrDone(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func loadConfig() (config, error) {
	cfg := config{
		dsn:            os.Getenv("STORAGE_DB_DSN"),
		protectedRoot:  os.Getenv("STORAGE_PROTECTED_ROOT"),
		quarantineRoot: os.Getenv("STORAGE_QUARANTINE_ROOT"),
		instanceID:     os.Getenv("STORAGE_BROKER_INSTANCE_ID"),
		epoch:          os.Getenv("STORAGE_EPOCH"),
		leaseSeconds:   30,
		pollInterval:   time.Second,
	}
	if value := os.Getenv("STORAGE_LEASE_SECONDS"); value != "" {
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return config{}, errors.New("storage broker config is invalid")
		}
		cfg.leaseSeconds = uint32(parsed)
	}
	if value := os.Getenv("STORAGE_POLL_INTERVAL_MS"); value != "" {
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil || parsed == 0 {
			return config{}, errors.New("storage broker config is invalid")
		}
		cfg.pollInterval = time.Duration(parsed) * time.Millisecond
	}
	if cfg.dsn == "" ||
		cfg.protectedRoot == "" ||
		cfg.quarantineRoot == "" ||
		cfg.instanceID == "" ||
		cfg.epoch == "" ||
		cfg.leaseSeconds < 5 ||
		cfg.leaseSeconds > 300 ||
		cfg.protectedRoot == cfg.quarantineRoot {
		return config{}, errors.New("storage broker config is invalid")
	}
	return cfg, nil
}
