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
 * Checks if port 1080 is already listening (SOCKS proxy from a previous run).
 * @returns {Promise<boolean>}
 */
async function isPortAlreadyListening() {
  return new Promise((resolve) => {
    const client = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
      client.destroy();
      resolve(true); // Port is open and reachable
    });
    client.on('error', () => {
      resolve(false); // Port not reachable
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Opens the SSH tunnel. Idempotent — if already open (by this process OR another),
 * skips silently and reuses the existing SOCKS proxy on port 1080.
 * @returns {Promise<void>}
 */
async function openTunnel() {
  if (tunnelOpen) {
    console.log('[TUNNEL] SOCKS5 already open at %s:%d (local state), skipping', SOCKS_HOST, SOCKS_PORT);
    return;
  }

  // Check if port 1080 is already listening from a previous/crashed process
  const portInUse = await isPortAlreadyListening();
  if (portInUse) {
    console.log('[TUNNEL] Port %d already in use — reusing existing SOCKS5 proxy at %s:%d', SOCKS_PORT, SOCKS_HOST, SOCKS_PORT);
    tunnelOpen = true;
    return;
  }

  // Cleanup any orphaned sshpass processes that might be hanging on port 1080
  try {
    execSync('pkill -f "sshpass.*ssh.*-D.*1080"', { stdio: 'ignore' });
    // Small delay to let the port be released
    await new Promise(r => setTimeout(r, 500));
    // Verify port is now free
    const stillInUse = await isPortAlreadyListening();
    if (stillInUse) {
      console.warn('[TUNNEL] Port %d still in use after cleanup, will try anyway', SOCKS_PORT);
    } else {
      console.log('[TUNNEL] Cleaned up orphaned tunnel processes');
    }
  } catch (e) {
    // pkill returns non-zero if no processes found — that's fine
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
  });
}

// Register signal handlers ONCE at module scope. Previously these were
// registered inside openTunnel(), so each retry added another listener —
// after 5 retries SIGINT would invoke cleanup 6 times. Idempotent cleanup
// is now safe to call from multiple paths.
const cleanup = () => {
  tunnelOpen = false;
  if (sshProcess) {
    sshProcess.kill('SIGTERM');
    sshProcess = null;
  }
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

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
