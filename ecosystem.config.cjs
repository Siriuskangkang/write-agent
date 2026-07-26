const path = require("node:path");

const rootDir = __dirname;
const brokerEnabled = process.env.STORAGE_AUTHORITY_MODE === "broker";

const apps = [
  {
    name: "write-agent-api",
    cwd: path.join(rootDir, "backend"),
    script: "dist/src/main.js",
    args: "",
    interpreter: "node",
    env: { NODE_ENV: process.env.NODE_ENV || "development" },
  },
  {
    name: "write-agent-worker",
    cwd: path.join(rootDir, "backend"),
    script: "dist/src/worker-main.js",
    args: "",
    interpreter: "node",
    env: {
      NODE_ENV: process.env.NODE_ENV || "development",
      WORKER_MODE: "true",
      ATOMIC_GROUNDING_METRICS_HOST: "127.0.0.1",
      ATOMIC_GROUNDING_METRICS_PORT: "9465",
    },
  },
  {
    name: "write-agent-web",
    cwd: path.join(rootDir, "frontend"),
    script: "node_modules/next/dist/bin/next",
    args: "start -p 8002",
    interpreter: "node",
    pmx: false,
    env: { NODE_ENV: "production" },
  },
];

if (brokerEnabled) {
  apps.push({
    name: "write-agent-storage-broker",
    cwd: path.join(rootDir, "storage-broker"),
    script: path.join(rootDir, "storage-broker/bin/write-agent-storage-broker"),
    interpreter: "none",
    instances: 1,
    autorestart: true,
    kill_timeout: 15000,
    env: {
      STORAGE_BROKER_CONTRACT: "storage-broker.v1",
    },
  });
}

module.exports = { apps };
