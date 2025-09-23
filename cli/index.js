#!/usr/bin/env node

/**
 * rustplus CLI – version adaptée (mode redirection / manuel)
 * - Ajoute les options `--no-launch`, `--host`, et la sous‑commande `pair-open`.
 * - Offre un mode où l'utilisateur est redirigé/ouvre l'URL dans SON navigateur (pas de --disable-web-security).
 * - Fournit aussi un formulaire manuel sur / où l'utilisateur peut coller un token si la fenêtre ne renvoie rien.
 */

const axios = require('axios');
const express = require('express');
const {v4: uuidv4} = require('uuid');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const ChromeLauncher = require('chrome-launcher');
const path = require('path');
const fs = require('fs');
const AndroidFCM = require('@liamcottle/push-receiver/src/android/fcm');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

let server;
let fcmClient;

function getConfigFile(options) {
    return options['config-file'] || path.join(process.cwd(), 'rustplus.config.json');
}

function readConfig(configFile) {
    try {
        return JSON.parse(fs.readFileSync(configFile));
    } catch (err) {
        return {};
    }
}

function updateConfig(configFile, config) {
    const currentConfig = readConfig(configFile);
    const updatedConfig = {...currentConfig, ...config};
    const json = JSON.stringify(updatedConfig, null, 2);
    fs.writeFileSync(configFile, json, 'utf8');
}

async function getExpoPushToken(fcmToken) {
    const response = await axios.post('https://exp.host/--/api/v2/push/getExpoPushToken', {
        type: 'fcm',
        deviceId: uuidv4(),
        development: false,
        appId: 'com.facepunch.rust.companion',
        deviceToken: fcmToken,
        projectId: '49451aca-a822-41e6-ad59-955718d0ff9c'
    });
    return response.data.data.expoPushToken;
}

async function registerWithRustPlus(authToken, expoPushToken) {
    return axios.post('https://companion-rust.facepunch.com:443/api/push/register', {
        AuthToken: authToken,
        DeviceId: 'rustplus.js',
        PushKind: 3,
        PushToken: expoPushToken
    });
}

async function findFreePort(host = '127.0.0.1') {
    return await new Promise((resolve, reject) => {
        const net = require('net');
        const srv = net.createServer();
        srv.listen(0, host, () => {
            const addr = srv.address();
            if (!addr || typeof addr === 'string') return reject(new Error('addr error'));
            const p = addr.port;
            srv.close(() => resolve(p));
        });
        srv.on('error', reject);
    });
}

/**
 * NEW: linkSteamWithRustPlus – redirect/manual-friendly
 * - N'ouvre pas Chrome côté serveur par défaut.
 * - Fournit une page '/' avec 2 options :
 *    1) instructions + bouton/link pour ouvrir la page de login (l'utilisateur ouvre dans SON navigateur)
 *    2) un champ pour coller manuellement le token si le flow n'envoie rien au callback
 * - Callback '/callback' fonctionne comme avant et résout la promesse quand token reçu.
 */
async function linkSteamWithRustPlus(options) {
    return new Promise(async (resolve, reject) => {
        const app = express();

        // Serve static pair.html content that includes a simple manual-token form and instructions
        app.get('/', (req, res) => {
            // pair.html expliqué :
            // - Affiche l'URL à ouvrir pour l'auth (login URL is the same as the page served here; user will click "Open Login" which actually opens Rust+ login flow in a new tab)
            // - Fournit un champ pour coller le token manuellement (si la page mobile/app n'envoie pas un callback)
            const host = options.host || '127.0.0.1';
            const port = server && server.address() && server.address().port ? server.address().port : '<port>'; // placeholder
            const callbackUrl = `http://${host}:${port}/callback`;

            res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Rust+ Pairing</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:24px}label{display:block;margin-top:12px}input{width:100%;padding:8px;margin-top:6px}button{margin-top:12px;padding:8px 12px}</style>
  </head>
  <body>
    <h1>Rust+ Pairing</h1>
    <p>Ouvre la page de connexion Rust+ dans ton navigateur (sur TON PC) en cliquant sur le bouton ci‑dessous. Une fois la connexion faite, Rust+ enverra un token au serveur (callback).</p>
    <p><strong>Si la redirection automatique ne fonctionne pas</strong>, colle manuellement le token fourni par l'application Rust+ dans le champ « Token » et clique sur <em>Submit</em>.</p>

    <div>
      <button id="openBtn">Open Rust+ login in new tab</button>
      <p style="font-size:0.9em;color:#666">Si ton navigateur bloque l'ouverture, copie-colle l'URL et ouvre-la manuellement.</p>
      <pre id="openUrl" style="background:#f6f6f6;padding:8px;border-radius:6px;display:none"></pre>
    </div>

    <form id="manualForm" method="POST" action="/submit-token">
      <label for="token">Token</label>
      <input id="token" name="token" placeholder="Colle ici le token reçu depuis Rust+" />
      <button type="submit">Submit Token</button>
    </form>

    <script>
      // --- Browser / OS detection helpers ---
      const ua = navigator.userAgent || '';
      const isChromium = !!window.chrome || /Chrome\//.test(ua) || /CriOS\//.test(ua) || /Edg\//.test(ua) || /OPR\//.test(ua) || /Brave\//i.test(ua);
      const isChromeDesktop = /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua) && !/Brave\//i.test(ua) && !/Mobile/.test(ua);
      const isAndroid = /Android/i.test(ua);
      const isIOS = /iPhone|iPad|iPod/i.test(ua);
      const isMac = /Macintosh|Mac OS X/i.test(ua);
      const isWindows = /Windows/i.test(ua);

      const host = '${host}';
      const port = '${port}';
      const httpUrl = 'http://' + host + ':' + port;

      // On mobile, we can try special schemes to explicitly ask for Chrome.
    }

    // Desktop: we cannot force-launch Chrome programmatically without a helper app.
    // Best effort: if already on a Chromium browser, just proceed; otherwise show instructions.
    function bestEffortOpen(url) {
        if (isChromium) {
            window.location.href = url;
            return true;
        }
        return false;
    }

    const openBtn = document.getElementById('openBtn');
    const openUrlPre = document.getElementById('openUrl');

    function renderAdvice() {
        let advice = '';
        if (isAndroid) {
            advice = "Sur Android, nous allons tenter d'ouvrir Chrome via un lien 'intent://'.";
        } else if (isIOS) {
            advice = "Sur iOS, nous allons tenter d'ouvrir Chrome via le schéma 'googlechrome://'.";
        } else if (isChromium) {
            advice = "Navigateur Chromium détecté — poursuite automatique possible.";
        } else {
            advice = "Pour une compatibilité maximale, ouvre cette URL dans Google Chrome sur ton ordinateur.";
        }
        openUrlPre.style.display = 'block';
        openUrlPre.textContent = httpUrl + '\n\n' + advice;
    }

    openBtn.addEventListener('click', () => {
        // 1) Try mobile Chrome schemes
        if (openInChromeMobile(httpUrl)) return;
        // 2) Best effort on desktop Chromium
        if (bestEffortOpen(httpUrl)) return;
        // 3) Fallback: show URL + instructions
        renderAdvice();
    });
</script>
</body>
</html>`);
        });

        // Accept manual token submissions from the form
        app.use(express.urlencoded({extended: true}));
        app.post('/submit-token', (req, res) => {
            const token = req.body && req.body.token;
            if (token) {
                res.send('Token reçu. Tu peux fermer cette fenêtre.');
                if (server) server.close();
                return resolve(token);
            }
            res.status(400).send('Token manquant');
        });

        // Callback endpoint that original flow tried to use
        app.get('/callback', async (req, res) => {
            const authToken = req.query.token;
            if (authToken) {
                res.send('Steam Account successfully linked with rustplus.js, you can now close this window and go back to the console.');
                if (server) server.close();
                return resolve(authToken);
            }

            // If there's no token in query, show the pairing page with instructions
            res.send(`<!doctype html><html><body><h2>Callback reçu — aucun token dans l'URL.</h2><p>Si tu as un token, colle-le dans <a href="/">la page de pairing</a>.</p></body></html>`);
        });

        const host = options.host || '127.0.0.1';
        const port = await findFreePort(host);

        server = app.listen(port, host, () => {
            const url = `http://${host}:${port}`;
            console.log('[pair] Pairing server started at: ' + url);

            // show QR code for convenience
            try {
                const qrcode = require('qrcode-terminal');
                qrcode.generate(url, {small: true});
            } catch (e) {
                // ignore if not installed
            }

            // If caller asked to auto-open browser on this host: try to launch (best-effort)
            if (!options['no-launch']) {
                // Try to open the user's browser on the server side. This will fail on a headless VPS,
                // but it's OK — we won't exit on failure: we will print the URL for the user to open
                ChromeLauncher.launch({startingUrl: url}).catch((err) => {
                    console.log('[pair] Could not auto-open browser on this host (likely headless).');
                    console.log('[pair] Please open this URL in your browser: ' + url);
                });
            } else {
                console.log('[pair] no-launch: server started, please open this URL in the user browser: ' + url);
            }
        });
    });
}

let expoPushToken = null;
let rustplusAuthToken = null;

async function fcmRegister(options) {
    console.log('Registering with FCM');
    const apiKey = 'AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY';
    const projectId = 'rust-companion-app';
    const gcmSenderId = '976529667804';
    const gmsAppId = '1:976529667804:android:d6f1ddeb4403b338fea619';
    const androidPackageName = 'com.facepunch.rust.companion';
    const androidPackageCert = 'E28D05345FB78A7A1A63D70F4A302DBF426CA5AD';

    const fcmCredentials = await AndroidFCM.register(
        apiKey,
        projectId,
        gcmSenderId,
        gmsAppId,
        androidPackageName,
        androidPackageCert
    );

    console.log('Fetching Expo Push Token');
    expoPushToken = await getExpoPushToken(fcmCredentials.fcm.token).catch((error) => {
        console.log('Failed to fetch Expo Push Token');
        console.log(error);
        process.exit(1);
    });

    console.log('Successfully fetched Expo Push Token');
    console.log('Expo Push Token: ' + expoPushToken);

    console.log('Starting pairing server (user will authenticate via their browser)');
    rustplusAuthToken = await linkSteamWithRustPlus(options);

    console.log('Successfully linked Steam account with Rust+');
    console.log('Rust+ AuthToken: ' + rustplusAuthToken);

    console.log('Registering with Rust Companion API');
    await registerWithRustPlus(rustplusAuthToken, expoPushToken).catch((error) => {
        console.log('Failed to register with Rust Companion API');
        console.log(error);
        process.exit(1);
    });
    console.log('Successfully registered with Rust Companion API.');

    const configFile = getConfigFile(options);
    updateConfig(configFile, {
        fcm_credentials: fcmCredentials,
        expo_push_token: expoPushToken,
        rustplus_auth_token: rustplusAuthToken
    });
    console.log('FCM, Expo and Rust+ auth tokens have been saved to ' + configFile);
}

// Parse une chaîne du type
// '{androidId:5572...,securityToken:5917...}'
// ou '{securityToken:5917..., androidId:5572...}'
// en renvoyant des CHAÎNES exactes sans perte de précision.
function parseRustCredsString(s) {
    if (typeof s !== 'string') {
        throw new Error('dataRust doit être une chaîne.');
    }

    // Nettoyage minimal
    const trimmed = s.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        throw new Error("Format inattendu pour dataRust (doit commencer par '{' et finir par '}').");
    }

    // On extrait chaque champ indépendamment, ordre libre, guillemets optionnels
    // Capture uniquement des suites de chiffres pour éviter toute coercition.
    const num = '"?([0-9]+)"?';
    const reAndroid = new RegExp(`\\bandroidId\\b\\s*:\\s*${num}`);
    const reToken   = new RegExp(`\\bsecurityToken\\b\\s*:\\s*${num}`);

    const mAndroid = trimmed.match(reAndroid);
    const mToken   = trimmed.match(reToken);

    if (!mAndroid || !mToken) {
        throw new Error(
            "Format inattendu pour dataRust. Attendu des clés 'androidId' et 'securityToken' (ordre indifférent)."
        );
    }

    const androidId = mAndroid[1];
    const securityToken = mToken[1];

    // Sanity checks
    const digits = /^\d+$/;
    if (!digits.test(androidId) || !digits.test(securityToken)) {
        throw new Error('androidId/securityToken doivent être uniquement des chiffres.');
    }

    return { androidId, securityToken };
}

async function fcmListen(options) {
    console.log('[fcm-listen] Listening for FCM Notifications');
    console.log(options.dataRust, typeof options.dataRust)
    // 1) dataRust est une chaîne non-JSON → on extrait proprement en CHAÎNES
    const { androidId, securityToken } = parseRustCredsString(options.dataRust);

    // 2) Logs utiles sans exposer les secrets
    console.log('[fcm-listen] androidId length:', androidId.length);
    console.log('[fcm-listen] securityToken length:', securityToken.length);
    console.log('[fcm-listen] androidId (prefix):', androidId.slice(0, 6) + '…');

    // 3) Connecte le client FCM avec des chaînes intactes (pas de Number)
    const client = new PushReceiverClient(androidId, securityToken, []);

    client.on('ON_DATA_RECEIVED', (data) => {
        const ts = new Date().toLocaleString();
        console.log('\x1b[32m%s\x1b[0m', `[${ts}] Notification Received`);
        console.dir(data, { depth: 5 });
    });

    client.on?.('ON_ERROR', (err) => {
        console.error('[fcm-listen] Client error:', err?.message || err);
    });

    process.once('SIGINT', () => {
        console.log('\n[fcm-listen] SIGINT reçu, arrêt.');
        process.exit(0);
    });

    try {
        await client.connect();
    } catch (err) {
        console.error('[fcm-listen] Échec connexion FCM:', err?.message || err);
        throw err;
    }
}


async function pairOpen(options) {
    const url = options.url;
    if (!url) {
        console.error('Usage: rustplus pair-open --url http://<host>:<port>');
        process.exit(1);
    }

    try {
        await ChromeLauncher.launch({
            startingUrl: url,
            chromeFlags: [
                '--disable-web-security',
                '--disable-popup-blocking',
                '--disable-site-isolation-trials',
                '--user-data-dir=/tmp/temporary-chrome-profile-dir-rustplus'
            ],
            handleSIGINT: false
        });
    } catch (e) {
        console.error(e);
        console.error('Failed to launch Chrome. Make sure Chrome/Chromium is installed or set CHROME_PATH.');
        process.exit(1);
    }
}

function showUsage() {
    const usage = commandLineUsage([
        {header: 'RustPlus', content: 'A command line tool for things related to Rust+'},
        {header: 'Usage', content: '$ rustplus <options> <command>'},
        {
            header: 'Command List',
            content: [
                {name: 'help', summary: 'Print this usage guide.'},
                {
                    name: 'fcm-register',
                    summary: 'Registers with FCM, Expo and links your Steam account with Rust+ so you can listen for Pairing Notifications.'
                },
                {
                    name: 'fcm-listen',
                    summary: 'Listens to notifications received from FCM, such as Rust+ Pairing Notifications.'
                },
                {
                    name: 'pair-open',
                    summary: 'Opens a pairing URL in Chrome with required flags (run this on the user\'s PC).'
                }
            ]
        },
        {
            header: 'Options',
            optionList: [
                {
                    name: 'config-file',
                    typeLabel: '{underline file}',
                    description: 'Path to config file. (default: rustplus.config.json)'
                },
                {
                    name: 'host',
                    typeLabel: '{underline host}',
                    description: 'Host/IP to bind the local pairing server (default: 127.0.0.1)'
                },
                {
                    name: 'no-launch',
                    typeLabel: '{underline flag}',
                    description: 'Do not attempt to launch a browser on the host. Useful for headless VPS.'
                },
                {
                    name: 'url',
                    typeLabel: '{underline url}',
                    description: '[pair-open] URL to open (e.g. http://127.0.0.1:3000)'
                }
            ]
        }
    ]);
    console.log(usage);
}

async function run() {
    const options = commandLineArgs([
        {name: 'command', type: String, defaultOption: true},
        {name: 'config-file', type: String},
        {name: 'host', type: String, defaultValue: '127.0.0.1'},
        {name: 'no-launch', type: Boolean, defaultValue: false},
        {name: 'url', type: String},
        {name: 'dataRust', type: String},

    ]);

    switch (options.command) {
        case 'fcm-register':
            await fcmRegister(options);
            break;
        case 'fcm-listen':
            await fcmListen(options);
            break;
        case 'pair-open':
            await pairOpen(options);
            break;
        case 'help':
            showUsage();
            break;
        default:
            showUsage();
            break;
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
    try {
        await ChromeLauncher.killAll();
    } catch (_) {
    }
    if (server) server.close();
    if (fcmClient) fcmClient.destroy();
}

run();
