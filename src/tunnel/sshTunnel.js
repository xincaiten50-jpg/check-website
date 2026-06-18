/**
 * SSH Tunnel — creates a local SOCKS5 proxy via SSH tunnel to a remote server.
 *
 * Uses system `ssh` command with sshpass for password auth.
 * Spawns: sshpass -p <pass> ssh -N -D 1080 -o StrictHostKeyChecking=no user@host
 *
 * Exported functions:
 *   openTunnel()  — opens SOCKS5 proxy at 127.0.0.1:1080; skips if already open
 *   closeTunnel() — kills SSH process and SOCKS5 server
 *
 * Env vars (from .env):
 *   SSH_HOST, SSH_PORT, SSH_USER, SSH_PASSWORD
 */

const { spawn, execSync } = require('child_process');
const net = require('net');

const SOCKS_PORT = 1080;
const SOCKS_HOST = '127.0.0.1';

let sshProcess = null;
let tunnelOpen = false;

/**
 * Opens the SSH tunnel. Idempotent — if already open, skips silently.
 * @returns {Promise<void>}
 */
async function openTunnel() {
  if (tunnelOpen) {
    console.log('[TUNNEL] SOCKS5 already open at %s:%d, skipping', SOCKS_HOST, SOCKS_PORT);
    return;
  }

  const host = process.env.SSH_HOST;
  const port = parseInt(process.env.SSH_PORT || '22', 10);
  const user = process.env.SSH_USER;
  const password = process.env.SSH_PASSWORD;

  if (!host || !user || !password) {
    throw new Error('[TUNNEL] Missing SSH config: SSH_HOST, SSH_USER, SSH_PASSWORD must be set in .env');
  }

  return new Promise((resolve, reject) => {
    let resolvedFlag = false;
    let rejectTimer = null;

    console.log('[TUNNEL] Starting SSH tunnel to %s:%d...', host, port);

    // Use sshpass with system ssh for reliable password auth
    // -N: no remote command (just port forwarding)
    // -D 1080: dynamic SOCKS5 proxy on localhost:1080
    // -o StrictHostKeyChecking=no: skip host key verification
    // -o ServerAliveInterval=30: keep connection alive
    // -o ExitOnForwardFailure=yes: exit if forwarding fails
    sshProcess = spawn('sshpass', [
      '-p', password,
      'ssh',
      '-N',
      '-D', `${SOCKS_HOST}:${SOCKS_PORT}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', `Port=${port}`,
      `${user}@${host}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    let stderrData = Buffer.alloc(0);

    sshProcess.stderr.on('data', (chunk) => {
      stderrData = Buffer.concat([stderrData, chunk]);
    });

    sshProcess.on('error', (err) => {
      if (!resolvedFlag) {
        resolvedFlag = true;
        clearTimeout(rejectTimer);
        console.error('[TUNNEL] Failed to start ssh process: %s', err.message);
        reject(err);
      }
    });

    sshProcess.on('close', (code) => {
      tunnelOpen = false;
      sshProcess = null;
      if (!resolvedFlag) {
        resolvedFlag = true;
        const stderrStr = stderrData.toString('utf8');
        console.error('[TUNNEL] SSH process exited with code %d. stderr: %s', code, stderrStr);
        reject(new Error(`SSH tunnel exited with code ${code}: ${stderrStr}`));
      }
    });

    // Give it a few seconds to establish the tunnel
    rejectTimer = setTimeout(() => {
      if (!resolvedFlag) {
        // Check if the process is still running and port is listening
        const netClient = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
          netClient.destroy();
          resolvedFlag = true;
          tunnelOpen = true;
          console.log('[TUNNEL] SOCKS5 opened at %s:%d (via sshpass+ssh)', SOCKS_HOST, SOCKS_PORT);
          resolve();
        });

        netClient.on('error', (err) => {
          if (!resolvedFlag) {
            resolvedFlag = true;
            tunnelOpen = false;
            if (sshProcess) {
              sshProcess.kill('SIGTERM');
              sshProcess = null;
            }
            const stderrStr = stderrData.toString('utf8').slice(0, 200);
            console.error('[TUNNEL] Tunnel timeout: port not listening. stderr: %s', stderrStr);
            reject(new Error(`SSH tunnel timeout: ${err.message}. stderr: ${stderrStr}`));
          }
        });
      }
    }, 8000);

    // Cleanup on signals
    const cleanup = () => {
      tunnelOpen = false;
      if (sshProcess) {
        sshProcess.kill('SIGTERM');
        sshProcess = null;
      }
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

/**
 * Closes the SSH connection and SOCKS5 server.
 * @returns {Promise<void>}
 */
async function closeTunnel() {
  return new Promise((resolve) => {
    if (sshProcess) {
      sshProcess.kill('SIGTERM');
      sshProcess = null;
      console.log('[TUNNEL] SSH process killed');
    }
    tunnelOpen = false;
    resolve();
  });
}

module.exports = { openTunnel, closeTunnel };
