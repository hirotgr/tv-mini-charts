'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const repositoryRoot = path.resolve(__dirname, '..');
const tlsConnectOptions = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function makeCertificates(directory) {
  const caConfig = path.join(directory, 'ca.cnf');
  const serverConfig = path.join(directory, 'server.cnf');
  const extensions = path.join(directory, 'server-ext.cnf');
  const files = {
    caKey: path.join(directory, 'ca.key'),
    caCert: path.join(directory, 'ca.crt'),
    serverKey: path.join(directory, 'server.key'),
    serverCsr: path.join(directory, 'server.csr'),
    serverCert: path.join(directory, 'server.crt'),
  };

  const configs = [
    [caConfig, '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3_ca\n[dn]\nCN=TV Mini Charts local test CA\n[v3_ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n'],
    [serverConfig, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=v3_req\n[dn]\nCN=secure-target.test\n[v3_req]\nsubjectAltName=DNS:secure-target.test\n'],
    [extensions, '[server_cert]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:secure-target.test\n'],
  ];

  for (const [file, contents] of configs) {
    fsSync.writeFileSync(file, contents, { mode: 0o600 });
  }

  const commands = [
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-config', caConfig, '-keyout', files.caKey, '-out', files.caCert],
    ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', serverConfig, '-keyout', files.serverKey, '-out', files.serverCsr],
    ['x509', '-req', '-in', files.serverCsr, '-CA', files.caCert, '-CAkey', files.caKey, '-CAcreateserial', '-out', files.serverCert, '-days', '2', '-sha256', '-extfile', extensions, '-extensions', 'server_cert'],
  ];

  for (const args of commands) {
    const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw result.error || new Error(result.stderr || 'openssl certificate generation failed');
    }
  }

  const certificate = spawnSync('openssl', ['x509', '-in', files.serverCert, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' });
  if (certificate.error || certificate.status !== 0 || !certificate.stdout.includes('DNS:secure-target.test')) {
    throw certificate.error || new Error(certificate.stderr || 'local certificate SAN is not secure-target.test');
  }

  return files;
}

function runClientProcess(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--client', ...args], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 1500);
      hardKill.unref();
      finish(new Error('proxy test child exceeded 30 seconds and was terminated'));
    }, 30000);
    timeout.unref();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', finish);
    child.once('close', (code) => {
      if (code === 0) {
        finish(null, stdout.trim());
      } else {
        finish(new Error(`proxy test child exited ${code}\n${stderr}\n${stdout}`));
      }
    });
  });
}

async function runClientRequests(args) {
  const [httpPortText, httpsPortText, directory] = args;
  const httpPort = Number(httpPortText);
  const httpsPort = Number(httpsPortText);
  const originalTlsConnect = tls.connect;
  tls.connect = function (...connectArgs) {
    const options = connectArgs[0] && typeof connectArgs[0] === 'object' ? connectArgs[0] : {};
    tlsConnectOptions.push({
      host: options.host || options.hostname || null,
      port: options.port || null,
      servername: options.servername || null,
      overSocket: Boolean(options.socket),
    });
    return Reflect.apply(originalTlsConnect, this, connectArgs);
  };
  const dependencyRoot = process.env.TVMC_PROXY_TEST_DEPENDENCY_ROOT;
  const getPackagePath = require.resolve('@electron/get/package.json', {
    paths: dependencyRoot ? [dependencyRoot] : [path.join(repositoryRoot, 'node_modules/app-builder-lib')],
  });
  const getRequire = createRequire(getPackagePath);
  const getPackage = JSON.parse(await fs.readFile(getPackagePath, 'utf8'));
  const globalAgentPackage = JSON.parse(await fs.readFile(getRequire.resolve('global-agent/package.json'), 'utf8'));
  const globalAgentRequire = createRequire(getRequire.resolve('global-agent/package.json'));
  const roarrPackage = JSON.parse(await fs.readFile(globalAgentRequire.resolve('roarr/package.json'), 'utf8'));
  const get = getRequire(path.dirname(getPackagePath));
  const expectedGlobalAgent = process.env.TVMC_PROXY_TEST_EXPECT_GLOBAL_AGENT || '3.0.0';

  assert.equal(getPackage.version, '3.1.0');
  assert.equal(globalAgentPackage.version, expectedGlobalAgent);
  if (expectedGlobalAgent === '3.0.0') assert.equal(roarrPackage.version, '3.3.0');
  assert.ok(globalThis.GLOBAL_AGENT, '@electron/get did not initialize global-agent');
  assert.equal(globalThis.GLOBAL_AGENT.HTTP_PROXY, process.env.HTTP_PROXY);
  assert.equal(globalThis.GLOBAL_AGENT.HTTPS_PROXY, process.env.HTTPS_PROXY);
  assert.equal(globalThis.GLOBAL_AGENT.NO_PROXY, '127.0.0.1');

  const downloader = new get.GotDownloader();
  const httpFile = path.join(directory, 'http-response.txt');
  const httpsFile = path.join(directory, 'https-response.txt');
  const bypassFile = path.join(directory, 'bypass-response.txt');

  await downloader.download(`http://http-target.test:${httpPort}/via-http-proxy`, httpFile, { quiet: true });
  await downloader.download(`https://secure-target.test:${httpsPort}/via-https-proxy`, httpsFile, { quiet: true });
  await downloader.download(`http://127.0.0.1:${httpPort}/no-proxy`, bypassFile, { quiet: true });

  assert.equal(await fs.readFile(httpFile, 'utf8'), 'origin:http:/via-http-proxy');
  assert.equal(await fs.readFile(httpsFile, 'utf8'), 'origin:https:/via-https-proxy');
  assert.equal(await fs.readFile(bypassFile, 'utf8'), 'origin:http:/no-proxy');

  return { get: getPackage.version, globalAgent: globalAgentPackage.version, roarr: roarrPackage.version, requests: 3, tlsConnectOptions };
}

async function runServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-mini-charts-proxy-'));
  const servers = [];
  const tunnelSockets = new Set();
  try {
    const certs = makeCertificates(directory);
    const httpRequests = [];
    const httpsRequests = [];
    const tlsPeerNames = [];
    const proxyHttpTargets = [];
    const connectTargets = [];
    const httpOrigin = http.createServer((request, response) => {
      httpRequests.push(request.url);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`origin:http:${request.url}`);
    });
    const httpsOrigin = https.createServer({ key: fsSync.readFileSync(certs.serverKey), cert: fsSync.readFileSync(certs.serverCert) }, (request, response) => {
      httpsRequests.push(request.url);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`origin:https:${request.url}`);
    });
    httpsOrigin.on('secureConnection', (socket) => tlsPeerNames.push(socket.servername));
    httpsOrigin.on('tlsClientError', (_error, socket) => tlsPeerNames.push(socket.servername));
    const httpPort = await listen(httpOrigin);
    servers.push(httpOrigin);
    const httpsPort = await listen(httpsOrigin);
    servers.push(httpsOrigin);

    const proxy = http.createServer((request, response) => {
      let target;
      try {
        target = new URL(request.url);
      } catch {
        response.writeHead(400).end('expected an absolute-form HTTP proxy request');
        return;
      }
      proxyHttpTargets.push(target.hostname);
      const upstream = http.request({
        host: '127.0.0.1',
        port: httpPort,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...request.headers, host: `127.0.0.1:${httpPort}` },
      }, (originResponse) => {
        response.writeHead(originResponse.statusCode || 502, originResponse.headers);
        originResponse.pipe(response);
      });
      upstream.once('error', () => response.writeHead(502).end('local HTTP origin failed'));
      request.pipe(upstream);
    });
    proxy.on('connect', (request, clientSocket, head) => {
      connectTargets.push(request.url);
      const expectedTarget = `secure-target.test:${httpsPort}`;
      if (request.url !== expectedTarget) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const upstream = net.connect(httpsPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      tunnelSockets.add(clientSocket);
      tunnelSockets.add(upstream);
      clientSocket.once('close', () => {
        tunnelSockets.delete(clientSocket);
        upstream.destroy();
      });
      upstream.once('close', () => {
        tunnelSockets.delete(upstream);
        clientSocket.destroy();
      });
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
      clientSocket.setTimeout(10000, () => clientSocket.destroy());
      upstream.setTimeout(10000, () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    servers.push(proxy);

    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const environment = {
      PATH: process.env.PATH || '',
      TMPDIR: directory,
      ELECTRON_GET_USE_PROXY: 'true',
      ELECTRON_GET_NO_PROGRESS: 'true',
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: '127.0.0.1',
      NODE_EXTRA_CA_CERTS: certs.caCert,
      TVMC_PROXY_TEST_EXPECT_GLOBAL_AGENT: process.env.TVMC_PROXY_TEST_EXPECT_GLOBAL_AGENT || '3.0.0',
      ROARR_LOG: process.env.ROARR_LOG || '',
    };
    if (process.env.TVMC_PROXY_TEST_DEPENDENCY_ROOT) {
      environment.TVMC_PROXY_TEST_DEPENDENCY_ROOT = process.env.TVMC_PROXY_TEST_DEPENDENCY_ROOT;
    }
    let clientResult;
    try {
      clientResult = await runClientProcess([String(httpPort), String(httpsPort), directory], environment);
    } catch (error) {
      error.message += `\nObserved HTTP origins: ${JSON.stringify(httpRequests)}\nObserved HTTPS origins: ${JSON.stringify(httpsRequests)}\nObserved proxy HTTP targets: ${JSON.stringify(proxyHttpTargets)}\nObserved CONNECT targets: ${JSON.stringify(connectTargets)}\nObserved TLS SNI names: ${JSON.stringify(tlsPeerNames)}`;
      throw error;
    }
    assert.deepEqual(httpRequests, ['/via-http-proxy', '/no-proxy']);
    assert.deepEqual(httpsRequests, ['/via-https-proxy']);
    assert.deepEqual(proxyHttpTargets, ['http-target.test']);
    assert.deepEqual(connectTargets, [`secure-target.test:${httpsPort}`]);
    assert.deepEqual(tlsPeerNames, ['secure-target.test']);
    console.log(`@electron/get ${clientResult}: HTTP proxy, HTTPS CONNECT, NO_PROXY passed`);
  } finally {
    for (const socket of tunnelSockets) socket.destroy();
    await Promise.all(servers.map(close));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--client') {
  runClientRequests(process.argv.slice(3))
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => {
      process.stderr.write(`${error.stack || error}\nObserved tls.connect options: ${JSON.stringify(tlsConnectOptions)}\n`);
      process.exitCode = 1;
    });
} else {
  runServer().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
