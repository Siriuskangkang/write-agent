const path = require("node:path");

const isProd = process.env.NODE_ENV === "production";
const rootDir = __dirname;
const brokerEnabled = process.env.STORAGE_AUTHORITY_MODE === "broker";

const apps = [
  {
    name: "write-agent-api",
    cwd: isProd ? "/home/TextWeaver/app/backend" : "./backend",
    script: "dist/src/main.js",
    args: "",
    interpreter: "node",
    env: { NODE_ENV: isProd ? "production" : "development" },
  },
  {
    name: "write-agent-worker",
    cwd: isProd ? "/home/TextWeaver/app/backend" : "./backend",
    script: "dist/src/worker-main.js",
    args: "",
    interpreter: "node",
    env: {
      NODE_ENV: isProd ? "production" : "development",
      WORKER_MODE: "true",
      ATOMIC_GROUNDING_METRICS_HOST: "127.0.0.1",
      ATOMIC_GROUNDING_METRICS_PORT: "9465",
    },
  },
  {
    name: "write-agent-web",
    cwd: isProd ? "/home/TextWeaver/app/frontend" : "./frontend",
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
