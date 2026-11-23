// Teste do envio REAL (sem mock): assinatura VAPID + criptografia aes128gcm enviadas por HTTP
// a um "serviço de push" local, que descriptografa a mensagem como o iPhone/navegador faria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-push-'));
const require = createRequire(import.meta.url);
const ece = require('http_ece');
const { openDb } = await import('../server/db.js');
const { saveSubscription, sendToUser, vapidKeys, setPushSender } = await import('../server/push.js');
const webpush = await import('web-push');

// Certificado autoassinado para o serviço de push local (confiado explicitamente; verificação TLS continua ativa).
const dir = process.env.DATA_DIR;
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
const cert = fs.readFileSync(path.join(dir, 'c.pem'));
const key = fs.readFileSync(path.join(dir, 'k.pem'));
setPushSender((sub, payload, opts) => webpush.sendNotification(sub, payload, { ...opts, agent: new https.Agent({ ca: cert }) }));

test('push real: VAPID + criptografia + entrega HTTP', async () => {
  const received = [];
  const server = https.createServer({ cert, key }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Chaves do "aparelho" (o que o navegador gera ao se inscrever)
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);

  const db = openDb(':memory:');
  db.prepare(`INSERT INTO users (id, email, name, password_hash, feed_token, created_at) VALUES (1,'a@b.c','A','x','t','now')`).run();
  saveSubscription(db, 1, { endpoint: `https://127.0.0.1:${port}/push/abc`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: authSecret.toString('base64url') } });

  const r = await sendToUser(db, 1, { title: 'Passar no mercado', body: 'Em 10 minutos — qui 25/12 às 16h00.', tag: 'ev-1-m10' });
  server.close();
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(received.length, 1);
  const { headers, body } = received[0];
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.urgency, 'high');
  assert.ok(Number(headers.ttl) > 0);
  // Cabeçalho VAPID: JWT assinado com a chave pública do servidor
  assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.ok(headers.authorization.includes(vapidKeys().publicKey));
  const jwtPayload = JSON.parse(Buffer.from(headers.authorization.split('t=')[1].split('.')[1], 'base64url').toString());
  assert.equal(jwtPayload.aud, `https://127.0.0.1:${port}`);
  // Descriptografa como o aparelho faria
  const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: authSecret.toString('base64url') });
  const msg = JSON.parse(plain.toString());
  assert.equal(msg.title, 'Passar no mercado');
  assert.match(msg.body, /Em 10 minutos/);
});
