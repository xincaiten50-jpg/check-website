/**
 * SSH Tunnel — creates a local SOCKS5 proxy via SSH tunnel to a remote server.
 *
 * Uses system `ssh` with public-key auth (no sshpass). The private key path
 * is read from SSH_KEY_PATH and may start with `~` (expanded via os.homedir()).
 * Spawns: ssh -i <key> -N -D 1080 -o BatchMode=yes -o IdentitiesOnly=yes
 *         -o StrictHostKeyChecking=accept-new user@host
 *
 * Exported functions:
 *   openTunnel()  — opens SOCKS5 proxy at 127.0.0.1:1080; skips if already open
 *   closeTunnel() — kills SSH process and SOCKS5 server
 *
 * Env vars (from .env):
 *   SSH_HOST, SSH_PORT, SSH_USER, SSH_KEY_PATH
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SOCKS_PORT = 1080;
const SOCKS_HOST = '127.0.0.1';

let sshProcess = null;
let tunnelOpen = false;

/**
 * Expand a leading `~` in a path to the current user's home directory.
 * Node does not do this automatically (only the shell does).
 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

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

  // Cleanup any orphaned ssh processes that might be hanging on port 1080
  try {
    execSync('pkill -f "ssh.*-D.*1080"', { stdio: 'ignore' });
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
  const rawKeyPath = process.env.SSH_KEY_PATH;
  const keyPath = expandHome(rawKeyPath);

  if (!host || !user || !keyPath) {
    throw new Error('[TUNNEL] Missing SSH config: SSH_HOST, SSH_USER, SSH_KEY_PATH must be set in .env');
  }

  // Fail fast with a clear message if the key file is missing — much easier
  // to debug than waiting for ssh to fail with a cryptic "Load key ...: No
  // such file or directory" deep in stderr.
  if (!fs.existsSync(keyPath)) {
    throw new Error(`[TUNNEL] SSH key not found at ${keyPath} — set SSH_KEY_PATH in .env (got: ${rawKeyPath})`);
  }

  return new Promise((resolve, reject) => {
    let resolvedFlag = false;
    let rejectTimer = null;

    console.log('[TUNNEL] Starting SSH tunnel to %s:%d (key: %s)...', host, port, keyPath);

    // ssh with public-key auth, no password prompts.
    // -N: no remote command (just port forwarding)
    // -D 1080: dynamic SOCKS5 proxy on localhost:1080
    // -o BatchMode=yes: never prompt; fail clearly if key is rejected
    // -o IdentitiesOnly=yes: only use the key we provided (avoid "too many auth failures")
    // -o StrictHostKeyChecking=accept-new: trust new hosts, reject changed ones
    // -o ServerAliveInterval=30: keep connection alive
    // -o ExitOnForwardFailure=yes: exit immediately if -D cannot bind
    sshProcess = spawn('ssh', [
      '-i', keyPath,
      '-N',
      '-D', String(SOCKS_PORT),
      '-p', String(port),
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      `${user}@${host}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    let stderrData = Buffer.alloc(0);

    sshProcess.stderr.on('data', (chunk) => {
      stderrData = Buffer.concat([stderrData, chunk]);
      // Log ssh stderr in real time so auth errors / bad-permission warnings
      // surface immediately instead of only at process exit.
      const text = chunk.toString('utf8').trim();
      if (text) console.error(`[TUNNEL] ssh: ${text}`);
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
          console.log('[TUNNEL] SOCKS5 opened at %s:%d (via ssh key auth)', SOCKS_HOST, SOCKS_PORT);
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
