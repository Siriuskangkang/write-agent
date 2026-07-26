#!/usr/bin/env node
// 服务器端 Webhook Server
// 接收 Codeup push webhook，触发部署脚本
// 位置: /home/TextWeaver/scripts/webhook-server.js
// 启动: pm2 start webhook-server.js --name textweaver-webhook

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = 9000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEPLOY_SCRIPT = '/home/TextWeaver/scripts/deploy.sh';
const LOG_FILE = '/home/TextWeaver/logs/webhook.log';

const fs = require('fs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

let deploying = false;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end('Not Found');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // 验证签名（Codeup 使用 X-Codeup-Token header）
    if (WEBHOOK_SECRET) {
      const token = req.headers['x-codeup-token'] || '';
      const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(body)
        .digest('hex');
      if (token !== expected) {
        log('签名验证失败');
        res.writeHead(403).end('Forbidden');
        return;
      }
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    // 只响应 deploy 分支的 push 事件
    const ref = payload.ref || '';
    if (!ref.endsWith('/deploy')) {
      log(`忽略非 deploy 分支推送: ${ref}`);
      res.writeHead(200).end('ignored');
      return;
    }

    if (deploying) {
      log('部署正在进行中，忽略本次请求');
      res.writeHead(202).end('deploying');
      return;
    }

    log(`收到 deploy 分支推送，开始部署...`);
    res.writeHead(200).end('ok');

    deploying = true;
    execFile('bash', [DEPLOY_SCRIPT], { timeout: 600000 }, (err, stdout, stderr) => {
      deploying = false;
      if (err) {
        log(`部署失败: ${err.message}`);
      } else {
        log('部署成功');
      }
    });
  });
});

fs.mkdirSync('/home/TextWeaver/logs', { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  log(`Webhook server 启动，监听 127.0.0.1:${PORT}`);
});
