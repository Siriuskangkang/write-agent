const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function run(relativePath, env = {}, args = []) {
  return spawnSync("bash", [path.join(root, relativePath), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parseEnvExample(relativePath) {
  const values = new Map();
  for (const line of read(relativePath).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

test("ecosystem keeps app processes and gates the non-HTTP broker", () => {
  const previousMode = process.env.STORAGE_AUTHORITY_MODE;
  delete process.env.STORAGE_AUTHORITY_MODE;
  delete require.cache[require.resolve("../ecosystem.config.cjs")];
  const dormant = require("../ecosystem.config.cjs");
  const dormantNames = dormant.apps.map((app) => app.name);
  assert.equal(
    dormantNames.filter(
      (candidate) => candidate === "write-agent-storage-broker",
    ).length,
    0,
  );

  process.env.STORAGE_AUTHORITY_MODE = "broker";
  delete require.cache[require.resolve("../ecosystem.config.cjs")];
  const ecosystem = require("../ecosystem.config.cjs");
  const names = ecosystem.apps.map((app) => app.name);
  for (const name of [
    "write-agent-api",
    "write-agent-worker",
    "write-agent-web",
  ]) {
    assert.equal(names.filter((candidate) => candidate === name).length, 1);
  }
  const brokers = ecosystem.apps.filter(
    (app) => app.name === "write-agent-storage-broker",
  );
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].instances, 1);
  assert.equal(brokers[0].interpreter, "none");
  assert.equal(brokers[0].env.PORT, undefined);
  assert.equal(brokers[0].env.STORAGE_BROKER_CONTRACT, "storage-broker.v1");
  assert.match(
    brokers[0].script,
    /storage-broker[/\\]bin[/\\]write-agent-storage-broker$/,
  );
  if (previousMode === undefined) delete process.env.STORAGE_AUTHORITY_MODE;
  else process.env.STORAGE_AUTHORITY_MODE = previousMode;
});

test("compose defaults to data services and binds MySQL to loopback", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /127\.0\.0\.1:3306:3306/);
  for (const service of ["backend", "worker", "frontend", "nginx"]) {
    assert.match(
      compose,
      new RegExp(`  ${service}:\\n    profiles: \\["app"\\]`),
    );
  }
  assert.doesNotMatch(
    compose,
    /\/var\/db\/textweaver\/storage:[^\n]*(?:rw|read-write)/i,
  );
});

test("environment examples default storage authority to dormant legacy mode", () => {
  for (const relativePath of [".env.example", "backend/.env.example"]) {
    const values = parseEnvExample(relativePath);
    assert.equal(values.get("STORAGE_AUTHORITY_MODE"), "legacy");
    assert.equal(
      values.get("STORAGE_PROTECTED_ROOT"),
      "/var/db/textweaver/storage",
    );
    assert.equal(
      values.get("STORAGE_QUARANTINE_ROOT"),
      "/var/db/textweaver/quarantine",
    );
    for (const key of [
      "STORAGE_BROKER_DATABASE_HOST",
      "STORAGE_BROKER_DATABASE_PORT",
      "STORAGE_BROKER_DATABASE_NAME",
      "STORAGE_BROKER_DATABASE_USER",
      "STORAGE_BROKER_DATABASE_PASSWORD",
      "STORAGE_BROKER_INSTANCE_ID",
      "STORAGE_BROKER_LEASE_SECONDS",
      "STORAGE_BROKER_POLL_INTERVAL_MS",
    ]) {
      assert.ok(values.get(key), `${relativePath} missing ${key}`);
    }
  }
});

test("package scripts expose only the explicit storage operations", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(
    packageJson.scripts["storage:preflight"],
    "bash scripts/storage-authority-preflight.sh",
  );
  assert.equal(
    packageJson.scripts["storage:activate"],
    "bash scripts/storage-authority-activate.sh",
  );
  assert.equal(
    packageJson.scripts["storage:negative-probe"],
    "bash scripts/storage-authority-negative-probe.sh",
  );
});

test("all operation scripts are valid Bash and expose help", () => {
  const scripts = [
    "scripts/storage-authority-preflight.sh",
    "scripts/storage-authority-activate.sh",
    "scripts/storage-authority-negative-probe.sh",
  ];
  const syntax = spawnSync(
    "bash",
    ["-n", ...scripts.map((script) => path.join(root, script))],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const script of scripts) {
    const help = run(script, {}, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  }
});

test("preflight is read-only and legacy mode fails before external checks", () => {
  const source = read("scripts/storage-authority-preflight.sh");
  assert.doesNotMatch(
    source,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|chown|chmod|mkdir)\b/i,
  );
  const result = run("scripts/storage-authority-preflight.sh", {
    STORAGE_AUTHORITY_MODE: "legacy",
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /STORAGE_AUTHORITY_MODE_NOT_BROKER/);
});

test("activation requires the Task 11.2 floor and exact confirmation", () => {
  const noFloor = run("scripts/storage-authority-activate.sh", {
    AUTHORING_AUTHORITY_FLOOR: "",
    CONFIRM_STORAGE_ACTIVATION: "",
  });
  assert.equal(noFloor.status, 78);
  assert.match(noFloor.stderr, /TASK11_2_AUTHORITY_FLOOR_UNPROVEN/);

  const noConfirmation = run("scripts/storage-authority-activate.sh", {
    AUTHORING_AUTHORITY_FLOOR: "task11.2-procedure-only.v1",
    CONFIRM_STORAGE_ACTIVATION: "",
  });
  assert.equal(noConfirmation.status, 78);
  assert.match(
    noConfirmation.stderr,
    /EXPLICIT_STORAGE_ACTIVATION_CONFIRMATION_REQUIRED/,
  );
});

test("even fully confirmed activation remains disabled and non-mutating", () => {
  const source = read("scripts/storage-authority-activate.sh");
  assert.doesNotMatch(
    source,
    /\b(?:mysql|pm2|docker|chown|chmod|mkdir|rm|insert|update|delete)\b/i,
  );
  const result = run("scripts/storage-authority-activate.sh", {
    AUTHORING_AUTHORITY_FLOOR: "task11.2-procedure-only.v1",
    CONFIRM_STORAGE_ACTIVATION: "activate-storage-broker-v1",
  });
  assert.equal(result.status, 78);
  assert.match(
    result.stderr,
    /STORAGE_AUTHORITY_ACTIVATION_DISABLED_CURRENT_BUILD/,
  );
});

test("negative probe cannot run without its explicit confirmation", () => {
  const result = run("scripts/storage-authority-negative-probe.sh", {
    CONFIRM_STORAGE_NEGATIVE_PROBE: "",
  });
  assert.equal(result.status, 78);
  assert.match(
    result.stderr,
    /EXPLICIT_STORAGE_NEGATIVE_PROBE_CONFIRMATION_REQUIRED/,
  );
});
