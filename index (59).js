const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const readlineSync = require('readline-sync');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { io } = require('socket.io-client');

// === CONSTANTS ===
const APP_ID = '348188';
// Note: Some endpoints use 5.8.0, others might use 12.4.0 (like space_list in index.js)
const APPVR = '5.8.0';
const PF = '7';

// === DOMAIN CONFIGURATION ===
function getDomains(country) {
    // Determine strict region code
    const regionCode = country ? country.toUpperCase() : 'US';

    // Supported ROW regions (CapCut may not support all countries)
    const supportedROW = ['SG', 'ID', 'BR', 'DE', 'GB', 'FR', 'JP', 'KR', 'IN', 'TH', 'VN', 'MY', 'PH'];
    
    if (regionCode === 'US') {
        return {
            login: 'https://login.us.capcut.com',
            join: 'https://web-edit.us.capcut.com',
            commerce: 'https://commerce.us.capcut.com',

            forceRegion: 'US', // Changed from ID to US to match request headers
            language: 'en',    // Changed to en to match request
            regionParams: 'us', // for loc parameter

            name: 'US (Updated)'
        };
    } else {
        // ROW (Rest of World)
        // Use SG as fallback for unsupported countries (like EG)
        const effectiveRegion = supportedROW.includes(regionCode) ? regionCode : 'SG';
        
        return {
            login: 'https://login-row.www.capcut.com',
            join: 'https://edit-api-sg.capcut.com',
            commerce: 'https://commerce-api-sg.capcut.com',

            forceRegion: effectiveRegion,  // Use supported region
            language: 'en',
            regionParams: effectiveRegion.toLowerCase(),

            name: `ROW (${regionCode} → ${effectiveRegion})`  // Show actual + effective
        };
    }
}

// === UTILS ===
function xorOperation(text, key = 5) {
    return [...text].map(c => String.fromCharCode(c.charCodeAt(0) ^ key)).join('');
}

// Global name style setting
let NAME_STYLE = 'random'; // 'random' or 'egyptian'

function generateRandomUsername() {
    if (NAME_STYLE === 'egyptian') {
        return generateEgyptianUsername();
    }
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    let username = '';
    for (let i = 0; i < 8; i++) username += letters[Math.floor(Math.random() * letters.length)];
    for (let i = 0; i < 4; i++) username += numbers[Math.floor(Math.random() * numbers.length)];
    username += Date.now().toString(36).slice(-4);
    return username;
}

function generateEgyptianUsername() {
    const names = [
        'ahmed','mohamed','ali','omar','hassan','hussein','mahmoud','khaled',
        'youssef','mostafa','karim','amr','tamer','waleed','samir','nader',
        'hossam','ehab','sherif','tarek','ramy','sami','fady','maged',
        'ayman','ashraf','adel','emad','hatem','wael','gamal','hamza',
        'ziad','marwan','anas','seif','adam','yassin','ibrahim','ismail'
    ];
    const initials = 'abcdefghijklmnopqrstuvwxyz';
    const name = names[Math.floor(Math.random() * names.length)];
    const style = Math.floor(Math.random() * 7);

    switch (style) {
        case 0: // ahmed92
            return name + Math.floor(Math.random() * 90 + 10);
        case 1: // ahmed_m
            return name + '_' + initials[Math.floor(Math.random() * 26)];
        case 2: // ahmed.h85
            return name + '.' + initials[Math.floor(Math.random() * 26)] + Math.floor(Math.random() * 90 + 10);
        case 3: // ahmed2003
            return name + (Math.floor(Math.random() * 15) + 1990);
        case 4: // ahmed_92m
            return name + '_' + Math.floor(Math.random() * 90 + 10) + initials[Math.floor(Math.random() * 26)];
        case 5: // a.ahmed7
            return initials[Math.floor(Math.random() * 26)] + '.' + name + Math.floor(Math.random() * 9 + 1);
        case 6: // ahmed_m5
            return name + '_' + initials[Math.floor(Math.random() * 26)] + Math.floor(Math.random() * 9 + 1);
        default:
            return name + Math.floor(Math.random() * 900 + 100);
    }
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    } catch (e) {
        console.error(chalk.red('[✖] config.json not found!'));
        process.exit(1);
    }
}

function readProxies() {
    try {
        return JSON.parse(fs.readFileSync('./proxies.json', 'utf8'));
    } catch (e) {
        console.error(chalk.red('[✖] proxies.json not found!'));
        process.exit(1);
    }
}

function now() {
    return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function getRegionOutputPath(country, fileType) {
    const regionCode = (country || 'US').toLowerCase();
    const dir = './results';

    // Create results directory if it doesn't exist
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // fileType should be 'created' or 'joined'
    return `${dir}/${regionCode}_${fileType}.txt`;
}

// === LINK POINTER SYSTEM ===
// Tracks which link index to start from (skips full links)
const LINK_POINTER_FILE = './link_pointer.json';

function readLinkPointer() {
    try {
        const data = JSON.parse(fs.readFileSync(LINK_POINTER_FILE, 'utf8'));
        return data.index || 0;
    } catch (e) {
        return 0;
    }
}

function writeLinkPointer(index) {
    try {
        fs.writeFileSync(LINK_POINTER_FILE, JSON.stringify({ index, updated: new Date().toISOString() }));
    } catch (e) {
        // Ignore write errors (non-critical)
    }
}

// === RESULTS PER LINK ===
const LINK_RESULTS_FILE = './results/link_results.txt';

// Store owner emails for each link
const linkOwners = {};

function parseLinkLine(line) {
    // Format: owner@email.com|https://link... OR just https://link...
    if (line.includes('|') && line.includes('@')) {
        const pipeIdx = line.indexOf('|');
        const owner = line.substring(0, pipeIdx).trim();
        const link = line.substring(pipeIdx + 1).trim();
        if (link.startsWith('http')) {
            linkOwners[link] = owner;
            return link;
        }
    }
    return line.trim();
}

function readLinks() {
    const rawLines = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean);
    return rawLines.map(parseLinkLine).filter(l => l.startsWith('http'));
}

function appendLinkResult(link, email, password, userName, userId) {
    try {
        if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });

        let content = '';
        try { content = fs.readFileSync(LINK_RESULTS_FILE, 'utf8'); } catch (e) {}

        // Build header with owner if available
        const owner = linkOwners[link];
        const linkHeader = `=== ${link} ===`;
        const ownerHeader = owner ? `=== Owner: ${owner} ===` : null;

        if (!content.includes(linkHeader)) {
            // New link section
            let newSection = (content.length > 0 ? '\n' : '');
            if (ownerHeader) newSection += ownerHeader + '\n';
            newSection += linkHeader + '\n';
            content += newSection;
        }

        // Parse sections to insert account in the right place
        const lines = content.split('\n');
        const headerIdx = lines.findIndex(l => l.trim() === linkHeader);

        // Find the end of this section (next header or end of file)
        let sectionEnd = lines.length;
        for (let i = headerIdx + 1; i < lines.length; i++) {
            if (lines[i].startsWith('=== ') && lines[i].endsWith(' ===')) {
                sectionEnd = i;
                break;
            }
        }

        // Remove old Total line if exists in this section
        for (let i = sectionEnd - 1; i > headerIdx; i--) {
            if (lines[i].startsWith('Total:')) {
                lines.splice(i, 1);
                sectionEnd--;
                break;
            }
        }

        // Remove any empty lines at end of section (keep it tight)
        while (sectionEnd > headerIdx + 1 && lines[sectionEnd - 1].trim() === '') {
            lines.splice(sectionEnd - 1, 1);
            sectionEnd--;
        }

        // Insert the new account (with user info if available)
        const userInfo = (userName || userId) ? `|${userName}|${userId}` : '';
        lines.splice(sectionEnd, 0, `${email}|${password}${userInfo}`);
        sectionEnd++;

        // Count accounts in this section
        let accountCount = 0;
        for (let i = headerIdx + 1; i < sectionEnd; i++) {
            if (lines[i].trim() !== '' && !lines[i].startsWith('Total:') && !lines[i].startsWith('=== ')) {
                accountCount++;
            }
        }

        // Add Total line
        lines.splice(sectionEnd, 0, `Total:${accountCount}`);

        fs.writeFileSync(LINK_RESULTS_FILE, lines.join('\n'));
    } catch (e) {
        // Fallback: just append
        try {
            fs.appendFileSync(LINK_RESULTS_FILE, `${link} → ${email}|${password}\n`);
        } catch (e2) {}
    }
}

function generateSign(url) {
    const deviceTime = Math.floor(Date.now() / 1000);
    const urlLast7 = url.slice(-7);
    const tdid = '';
    const signString = `9e2c|${urlLast7}|${PF}|${APPVR}|${deviceTime}|${tdid}|11ac`;
    const sign = crypto.createHash('md5').update(signString).digest('hex').toLowerCase();
    return { sign, deviceTime };
}

function generateDeviceId() {
    return crypto.randomBytes(9).readBigUInt64BE(0).toString();
}

// Generate verifyFp token (dynamic to avoid rate limits)
function generateVerifyFp() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let fp = 'verify_';
    for (let i = 0; i < 8; i++) fp += chars[Math.floor(Math.random() * chars.length)];
    fp += '_';
    for (let i = 0; i < 8; i++) fp += chars[Math.floor(Math.random() * chars.length)];
    fp += '_';
    for (let i = 0; i < 4; i++) fp += chars[Math.floor(Math.random() * chars.length)];
    fp += '_';
    for (let i = 0; i < 4; i++) fp += chars[Math.floor(Math.random() * chars.length)];
    fp += '_';
    for (let i = 0; i < 12; i++) fp += chars[Math.floor(Math.random() * chars.length)];
    return fp;
}

const log = {
    info: (m) => console.log(`${chalk.gray(`[${now()}]`)} ${chalk.gray('[INFO]')} ${m}`),
    ok: (m) => console.log(`${chalk.gray(`[${now()}]`)} ${chalk.green('[OK]')} ${m}`),
    warn: (m) => console.log(`${chalk.gray(`[${now()}]`)} ${chalk.yellow('[WARN]')} ${m}`),
    err: (m) => console.log(`${chalk.gray(`[${now()}]`)} ${chalk.red('[ERR]')} ${m}`)
};

// === OTP FROM TEMP MAIL (notificon WebSocket — updated 2026-07-24) ===
// generator.email اتحول لـ SPA، الطريقة الوحيدة الشغّالة دلوقتي هي
// wss://generator.email/notificon/ws?email=<encoded_email>
// الكود بيوصل في subject الرسالة مباشرة.
async function getVerificationCode(email) {
    let WebSocket;
    try {
        WebSocket = require('ws');
    } catch (e) {
        log.err(`Missing "ws" package. Run: npm install ws`);
        return null;
    }

    return new Promise((resolve) => {
        let done = false;
        let ws = null;
        const finish = (code) => {
            if (done) return;
            done = true;
            try { if (ws) ws.close(); } catch {}
            resolve(code);
        };

        const encoded = encodeURIComponent(email.toLowerCase());
        const wsUrl = `wss://generator.email/notificon/ws?email=${encoded}`;

        try {
            ws = new WebSocket(wsUrl, {
                headers: {
                    'Origin': 'https://generator.email',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                },
                handshakeTimeout: 15000
            });
        } catch (e) {
            log.err(`WS init failed for ${email}: ${e.message}`);
            return resolve(null);
        }

        ws.on('message', (data) => {
            try {
                const str = data.toString();
                let obj;
                try { obj = JSON.parse(str); } catch { return; }

                if (obj.type !== 'mail') return;

                const from = String(obj.from || '');
                const subject = String(obj.subject || '');
                const isCapCut = /capcut/i.test(from) || /capcut/i.test(subject) || /verification code/i.test(subject);
                if (!isCapCut) return;

                const patterns = [
                    /verification code is\s*(\d{6})/i,
                    /verification code[\s:]*(\d{6})/i,
                    /code is\s*(\d{6})/i,
                    /(\d{6})/
                ];
                for (const pat of patterns) {
                    const m = subject.match(pat);
                    if (m && m[1]) {
                        const code = m[1];
                        // Reject years
                        if (code.startsWith('20') || code.startsWith('19')) {
                            const num = parseInt(code.substring(0, 4));
                            if (num >= 1900 && num <= 2100) continue;
                        }
                        return finish(code);
                    }
                }
            } catch (e) {}
        });

        ws.on('error', (e) => {
            log.err(`WS error for ${email}: ${e.message}`);
            finish(null);
        });
        ws.on('close', () => finish(null));

        // Overall timeout (30s)
        setTimeout(() => finish(null), 30000);
    });
}

// === CAPCUT API ===
async function checkEmail(email, agent, domains) {
    const res = await axios.post(
        `${domains.login}/passport/web/user/check_email_registered`,
        new URLSearchParams({ mix_mode: '1', email, fixed_mix_mode: '1' }),
        {
            params: { aid: APP_ID, language: domains.language, check_region: '1' },
            headers: { 'user-agent': 'Mozilla/5.0' },
            httpsAgent: agent,
            timeout: 10000
        }
    );
    return res.data;
}

async function sendCode(email, password, agent, domains) {
    const res = await axios.post(
        `${domains.login}/passport/web/email/send_code/`,
        new URLSearchParams({ mix_mode: '1', email, password, type: '34', fixed_mix_mode: '1' }),
        {
            params: { aid: APP_ID, language: domains.language, check_region: '1' },
            headers: { 'user-agent': 'Mozilla/5.0' },
            httpsAgent: agent,
            timeout: 10000
        }
    );
    return res.data;
}

async function regist(email, password, otpHex, agent, domains, deviceId, verifyFp) {
    const res = await axios.post(
        `${domains.login}/passport/web/email/register_verify_login/`,
        new URLSearchParams({
            mix_mode: '1',
            email,
            code: otpHex,
            password,
            type: '34',
            birthday: '2004-02-06',
            force_user_region: domains.forceRegion,
            biz_param: '{"invite_code":"HnxC0b95636945"}',
            check_region: '1',
            fixed_mix_mode: '1'
        }),
        {
            params: {
                aid: APP_ID,
                language: domains.language,
                check_region: '1',
                account_sdk_source: 'web',
                sdk_version: '2.1.10-tiktok',
                verifyFp: verifyFp
            },
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'appid': APP_ID,
                'did': deviceId,
                'Origin': 'https://www.capcut.com',
                'Referer': 'https://www.capcut.com/',
                'store-country-code': domains.regionParams,
                'store-country-code-src': 'uid'
            },
            httpsAgent: agent,
            timeout: 10000
        }
    );

    // Extract all cookies from registration response
    let session = '';
    if (res.data?.message === 'success') {
        const setCookies = res.headers['set-cookie'];
        if (setCookies) {
            // Join all cookies to act as the session string
            session = setCookies.map(c => c.split(';')[0]).join('; ');
        }
    }

    return { data: res.data, session };
}

// === LOGIN (FIXED to match Registration headers) ===
// maxAttempts: default 20 for normal use, use lower value for AUTO region detection
async function loginCapcut(email, password, agent, domains, deviceId, maxAttempts = 20) {
    const encryptedEmail = Buffer.from(xorOperation(email)).toString('hex');
    const encryptedPassword = Buffer.from(xorOperation(password)).toString('hex');
    const verifyFp = generateVerifyFp();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const res = await axios.post(
                `${domains.login}/passport/web/email/login/`,
                new URLSearchParams({
                    mix_mode: '1',
                    email: encryptedEmail,
                    password: encryptedPassword,
                    fixed_mix_mode: '1'
                }),
                {
                    params: {
                        aid: APP_ID,
                        language: domains.language,
                        check_region: '1',
                        account_sdk_source: 'web',
                        sdk_version: '2.1.10-tiktok',
                        verifyFp: verifyFp
                    },
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                        'Origin': 'https://www.capcut.com',
                        'Referer': 'https://www.capcut.com/',
                        'appid': APP_ID,
                        'did': deviceId,
                        'store-country-code': domains.regionParams,
                        'store-country-code-src': 'uid'
                    },
                    httpsAgent: agent,
                    timeout: 20000
                }
            );

            if (res.data?.message === 'success') {
                const setCookies = res.headers['set-cookie'];
                if (setCookies && setCookies.length > 0) {
                    return setCookies.map(c => c.split(';')[0]).join('; ');
                }
                // Login succeeded but no cookies - throw error instead of continuing
                throw new Error('Login success but no session cookies returned');
            }

            // Get error description
            const errDesc = res.data?.data?.description || res.data?.message || '';
            const errCode = res.data?.data?.error_code || res.data?.error_code || '';
            
            // Rate limit - wait and retry
            if (errDesc.includes('number of attempts reached') || errDesc.includes('rate') || errDesc.includes('too many')) {
                log.warn(`Login attempt ${attempt + 1}: Rate limited (waiting 2s)...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            
            // CRITICAL: User not found in this region - fail fast for AUTO mode
            if (errDesc.includes('not exist') || errDesc.includes('not found') || errDesc.includes('does not exist') || 
                errDesc.includes('user_not_found') || errCode === '1102' || errCode === '2101') {
                throw new Error(`WRONG_REGION: User not found in this region`);
            }
            
            // Wrong password/email - don't retry
            if (errDesc.includes('incorrect') || errDesc.includes('wrong') || errDesc.includes('invalid') || 
                errDesc.includes('password') || errCode === '1101') {
                throw new Error(`Login failed: ${errDesc || 'incorrect credentials'}`);
            }
            
            throw new Error(res.data?.message || `Login failed: ${errDesc || 'Unknown error'}`);
        } catch (err) {
            // WRONG_REGION error - fail immediately (for AUTO mode)
            if (err.message.includes('WRONG_REGION')) {
                throw err;
            }
            
            log.warn(`Login attempt ${attempt + 1} failed: ${err.message}`);
            
            if (err.message.includes('number of attempts reached') || err.message.includes('rate')) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            // Don't retry on authentication errors
            if (err.message.includes('incorrect') || err.message.includes('wrong') || err.message.includes('invalid')) {
                throw err;
            }
            if (attempt >= maxAttempts - 1) throw err;
        }
    }
    throw new Error(`Login failed after ${maxAttempts} attempts`);
}

// === RESOLVE & JOIN & EXPIRE CHECK ===
async function resolveShortLink(shortLink, agent) {
    const res = await axios.get(shortLink, {
        maxRedirects: 0,
        validateStatus: s => [200, 301, 302].includes(s),
        httpsAgent: agent,
        timeout: 15000
    });
    if (res.headers.location) return res.headers.location.replace(/&amp;/g, '&');
    const m = (res.data || '').match(/href="([^"]+)"/i);
    if (m) return m[1].replace(/&amp;/g, '&');
    throw new Error('No redirect found');
}

async function joinWorkspaceWithInvite(cookie, resolvedLink, agent, domains) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.post(
                `${domains.join}/cc/v1/workspace/join_workspace_with_apply`,
                {
                    join_workspace_type: 1,
                    invite_link_param: { invitation_link: resolvedLink },
                    application_param: {}
                },
                {
                    headers: {
                        'device-time': '1759683090',
                        'sign-ver': '1',
                        appvr: APPVR,
                        sign: 'd15774df3cc33528b8e1422fdc7dbc5b',
                        lan: 'en',
                        pf: PF,
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        cookie
                    },
                    httpsAgent: agent,
                    timeout: 20000
                }
            );
            const d = res.data;
            // Support multiple success return formats
            if (d.ret === '0' || (d.errmsg && d.errmsg.toLowerCase().includes('success'))) {
                // Try to get workspace ID
                const workspaceId = d.data?.workspace_id || d.data?.workspace_info?.workspace_id;
                if (!workspaceId) {
                    log.warn(`Workspace ID not found in join response: ${JSON.stringify(d)}`);
                }
                return { status: 'success', data: d, workspaceId };
            }

            if (d.ret === '2311') return { status: 'already' };
            if (d.ret === '2308') return { status: 'member_full' };
            if (d.ret === '2323') return { status: 'invalid_link' };
            if (d.ret === '1014') {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                continue;
            }
            return { status: 'failed', data: d };
        } catch (err) {
            if (err.response?.data?.ret === '1014' && i < 2) {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                continue;
            }
            return { status: 'error', error: err.message };
        }
    }
    return { status: 'busy' };
}

async function checkExpiration(workspaceId, cookieString, agent, domains, deviceId) {
    try {
        if (!workspaceId) return null;

        const spaceListUrl = `${domains.commerce}/commerce/v1/subscription/workspace/space_list`;
        const { sign, deviceTime } = generateSign(spaceListUrl);

        const res = await axios.post(
            spaceListUrl,
            { aid: parseInt(APP_ID), workspace_id: workspaceId },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': domains.login,
                    'Referer': `${domains.login}/`,
                    'cookie': cookieString, // use full cookie string
                    'appid': APP_ID,
                    'did': deviceId,
                    'device-time': deviceTime.toString(),
                    'app-sdk-version': '48.0.0', // from index.js
                    'appvr': '12.4.0', // from index.js (seems specific to this endpoint)
                    'lan': 'en',
                    'loc': domains.regionParams,
                    'pf': PF,
                    'sign': sign,
                    'sign-ver': '1',
                    'web_id': deviceId
                },
                httpsAgent: agent,
                timeout: 10000
            }
        );

        if (res.data?.data?.space_list?.[0]?.space_end) {
            const spaceEnd = res.data.data.space_list[0].space_end;
            return new Date(spaceEnd * 1000).toISOString().split('T')[0];
        } else {
            // Only warn if it's strictly an error, empty list might be valid
            if (res.data?.ret !== '0') {
                log.warn(`Space list format unexpected: ${JSON.stringify(res.data)}`);
            }
        }
        return null;
    } catch (err) {
        log.warn(`Failed to check expire: ${err.message}`);
        return null;
    }
}


// === CHANGE PASSWORD VIA BROWSER (PUPPETEER) ===

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Send reset email via PURE API (no browser needed!)
async function sendResetEmailAPI(email, agent, domains) {
    const encryptedEmail = Buffer.from(xorOperation(email)).toString('hex');
    const verifyFp = generateVerifyFp();
    const nextUrl = 'https://www.capcut.com/forget-password?enter_from=&current_page=';

    const res = await axios.post(
        `${domains.login}/passport/web/email/send_code/`,
        new URLSearchParams({
            mix_mode: '1',
            email: encryptedEmail,
            type: '31',
            next: nextUrl,
            fixed_mix_mode: '1'
        }),
        {
            params: {
                aid: APP_ID,
                account_sdk_source: 'web',
                sdk_version: '2.1.10-tiktok',
                language: domains.language,
                verifyFp: verifyFp
            },
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'Origin': 'https://www.capcut.com',
                'Referer': 'https://www.capcut.com/'
            },
            httpsAgent: agent,
            timeout: 15000
        }
    );

    return res.data;
}

// Close ads/popups - EXACT V11 CODE
async function closeAdsAndPopups(page) {
    try {
        await page.evaluate(() => {
            const closeButtons = document.querySelectorAll('[class*="close"], [class*="Close"], [aria-label*="close"], [aria-label*="Close"], .close, .modal-close, .popup-close, .ad-close');
            closeButtons.forEach(btn => { try { btn.click(); } catch(e) {} });
            const allButtons = document.querySelectorAll('button, div, span, a');
            allButtons.forEach(btn => {
                const text = btn.textContent.trim();
                if (text === '×' || text === 'X' || text === 'x' || text === '✕' || text === '✖')
                    try { btn.click(); } catch(e) {}
            });
            const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="popup"], [class*="ad-"], [id*="ad-"], [class*="advertisement"]');
            overlays.forEach(el => { try { el.remove(); } catch(e) {} });
            const fixedElements = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
            fixedElements.forEach(el => {
                if (el.innerHTML.toLowerCase().includes('ad') || el.innerHTML.toLowerCase().includes('sponsor'))
                    try { el.remove(); } catch(e) {}
            });
        });
    } catch (e) {}
}

// Fetch reset link - EXACT V11 CODE (this works!)
async function fetchResetLinkViaBrowser(page, fullEmail) {
    const email = fullEmail.split('@')[0];
    const domain = fullEmail.split('@')[1];
    
    const emailUrl = `https://generator.email/${domain}/${email}`;
    await page.goto(emailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1000);
    await closeAdsAndPopups(page);
    await sleep(500);
    
    try {
        const emailClicked = await page.evaluate(() => {
            // Method 1: Find all table rows and click the first data row
            const rows = document.querySelectorAll('tr');
            let isFirstDataRow = false;
            
            for (const row of rows) {
                const text = row.textContent.toLowerCase();
                
                if (text.includes('from') && text.includes('subject') && text.includes('time')) {
                    isFirstDataRow = true;
                    continue;
                }
                
                if (text.includes('capcut') || (text.includes('password') && text.includes('reset'))) {
                    row.click();
                    return 'clicked_row';
                }
            }
            
            // Method 2: Try clicking on td elements directly
            const cells = document.querySelectorAll('td');
            for (const cell of cells) {
                const text = cell.textContent.toLowerCase();
                if (text.includes('password reset') || text.includes('capcut')) {
                    cell.click();
                    return 'clicked_cell';
                }
            }
            
            // Method 3: Try clicking on any element with exact text
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
                if (el.textContent === 'CapCut password reset request') {
                    el.click();
                    return 'clicked_exact';
                }
            }
            
            // Method 4: Click on links inside table
            const links = document.querySelectorAll('tr a, td a');
            for (const link of links) {
                if (link.textContent.toLowerCase().includes('password')) {
                    link.click();
                    return 'clicked_link';
                }
            }
            
            return null;
        });
        
        if (!emailClicked) return null;
        
        await sleep(1500);
        await closeAdsAndPopups(page);
        await sleep(1000);
        
    } catch (e) { return null; }
    
    // Find the reset link inside the opened email
    const resetLink = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
            const href = link.href || '';
            const text = link.textContent || '';
            if (href.includes('forget-password') && href.includes('capcut')) return href;
            if (href.includes('reset') && href.includes('capcut')) return href;
            if (text.toLowerCase().includes('reset password') && href.includes('capcut')) return href;
        }
        
        const allText = document.body.innerHTML;
        const match = allText.match(/https:\/\/www\.capcut\.com\/forget-password\?[^"'\s<>]+/i);
        if (match) {
            let link = match[0];
            link = link.replace(/&amp;/g, '&');
            return link;
        }
        
        const allLinks = document.querySelectorAll('[href*="forget-password"]');
        if (allLinks.length > 0) return allLinks[0].href;
        
        return null;
    });
    
    if (resetLink) return resetLink.replace(/&amp;/g, '&');
    return null;
}

// [PATCH RESET_LINK_API_v1] Fast API-based reset link fetcher (no browser needed)
// Uses generator.email's notificon WebSocket + inbox<N> endpoint
// Discovered via trace_reset_link.js — 7 of 8 inbox servers work
async function fetchResetLinkViaAPI(fullEmail, timeoutMs = 60000) {
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch (e) {
        log.err('Missing "ws" package. Run: npm install ws');
        return null;
    }

    // Step 1: Wait for the mail arrival frame via WebSocket
    const frame = await new Promise((resolve) => {
        let done = false;
        let ws = null;
        const finish = (val) => {
            if (done) return;
            done = true;
            try { if (ws) ws.close(); } catch {}
            resolve(val);
        };

        const encoded = encodeURIComponent(fullEmail.toLowerCase());
        const wsUrl = `wss://generator.email/notificon/ws?email=${encoded}`;

        try {
            ws = new WebSocket(wsUrl, {
                headers: {
                    'Origin': 'https://generator.email',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                },
                handshakeTimeout: 15000
            });
        } catch (e) { return resolve(null); }

        ws.on('message', (data) => {
            try {
                const obj = JSON.parse(data.toString());
                if (obj.type !== 'mail') return;
                const from = String(obj.from || '');
                const subject = String(obj.subject || '');
                const isCapCut = /capcut/i.test(from) || /capcut/i.test(subject);
                if (!isCapCut) return;
                if (obj.link) finish(obj);
            } catch {}
        });
        ws.on('error', () => finish(null));
        ws.on('close', () => finish(null));
        setTimeout(() => finish(null), timeoutMs);
    });

    if (!frame || !frame.link) return null;

    // Step 2: Fetch the message body via inbox<N> endpoint
    // Try all 8 inbox servers in parallel — first success wins
    const RESET_LINK_REGEX = /https:\/\/www\.capcut\.com\/forget-password\?[^"'\s<>]+/i;
    const inboxCtx = frame.link.replace(/\//g, '%2F');

    const tryInbox = async (n) => {
        try {
            const res = await axios.get(`https://generator.email/inbox${n}/`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': `https://generator.email/inbox${n}/`,
                    'Cookie': `inbox_n=${n}; inbox_ctx=${inboxCtx}`,
                    'sec-fetch-dest': 'document',
                    'sec-fetch-mode': 'navigate',
                    'sec-fetch-site': 'same-origin',
                    'upgrade-insecure-requests': '1'
                },
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true
            });
            const body = String(res.data || '');
            const match = body.match(RESET_LINK_REGEX);
            if (match) return match[0].replace(/&amp;/g, '&');
            return null;
        } catch (e) { return null; }
    };

    // Race all 9 inboxes (generator.email uses inbox1-inbox9) — first success wins
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => tryInbox(n)));
    for (const link of results) {
        if (link) return link;
    }
    return null;
}


// WebSocket-based email arrival detection
// [PATCH RESET_LINK_API_v2] WebSocket-based email arrival detection (notificon)
// Old socket.io endpoint no longer works. This uses generator.email's new notificon WebSocket.
// Returns { arrived: true, link: "domain/user/msgid" } or { arrived: false, link: null }
function waitForEmailWS(email, timeoutMs = 20000) {
    return new Promise((resolve) => {
        let WebSocket;
        try { WebSocket = require('ws'); }
        catch (e) {
            log.err('Missing "ws" package. Run: npm install ws');
            return resolve({ arrived: false, link: null, clickgo: null });
        }

        let done = false;
        let ws = null;
        const finish = (val) => {
            if (done) return;
            done = true;
            try { if (ws) ws.close(); } catch {}
            resolve(val);
        };

        const encoded = encodeURIComponent(email.toLowerCase());
        const wsUrl = `wss://generator.email/notificon/ws?email=${encoded}`;

        try {
            ws = new WebSocket(wsUrl, {
                headers: {
                    'Origin': 'https://generator.email',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                },
                handshakeTimeout: 15000
            });
        } catch (e) {
            return finish({ arrived: false, link: null, clickgo: null });
        }

        ws.on('message', (data) => {
            try {
                const obj = JSON.parse(data.toString());
                if (obj.type !== 'mail') return;
                const from = String(obj.from || '');
                const subject = String(obj.subject || '');
                const isCapCut = /capcut/i.test(from) || /capcut/i.test(subject);
                if (!isCapCut) return;
                if (obj.link) {
                    // Keep both keys for compatibility: link (new) and clickgo (old)
                    finish({ arrived: true, link: obj.link, clickgo: obj.link, subject });
                }
            } catch {}
        });
        ws.on('error', () => finish({ arrived: false, link: null, clickgo: null }));
        ws.on('close', () => { if (!done) finish({ arrived: false, link: null, clickgo: null }); });

        setTimeout(() => finish({ arrived: false, link: null, clickgo: null }), timeoutMs);
    });
}

// Full password change process
// === FAST password change: reuses ONE browser per worker ===
// Instead of launching Chrome for EVERY email (slow!),
// each worker launches Chrome ONCE and reuses it for ALL emails.
// regionMode: 'US', 'ROW', or 'AUTO' (tries both with fallback)

async function changeOnePassword(threadId, page, email, newPassword, proxy, regionMode = 'AUTO', useApiOnly = false) {
    const agent = (proxy && proxy.proxyString) ? new HttpsProxyAgent(proxy.proxyString) : undefined;
    
    // Determine which regions to try based on mode
    let domainsToTry = [];
    if (regionMode === 'US') {
        domainsToTry = [{ domains: getDomains('US'), label: '🇺🇸 US' }];
    } else if (regionMode === 'ROW') {
        domainsToTry = [{ domains: getDomains('SG'), label: '🌍 ROW' }];
    } else {
        // AUTO mode: try ROW first (more common), then US as fallback
        domainsToTry = [
            { domains: getDomains('SG'), label: '🌍 ROW' },
            { domains: getDomains('US'), label: '🇺🇸 US' }
        ];
    }

    let lastError = null;

    // Try each region until one works
    for (let domainIndex = 0; domainIndex < domainsToTry.length; domainIndex++) {
        const { domains, label } = domainsToTry[domainIndex];
        const isLastRegion = domainIndex === domainsToTry.length - 1;

        try {
            // ============================================
            // STEP 1: Send reset email via API (with proxy)
            // ============================================
            log.info(`[Thread ${threadId}] ${label} Sending reset request: ${email}`);
            
            // Start WebSocket listener BEFORE sending reset
            const wsPromise = waitForEmailWS(email, 20000);
            
            // Retry up to 3 times on rate limit
            let sendSuccess = false;
            for (let sendAttempt = 0; sendAttempt < 3; sendAttempt++) {
                try {
                    const res = await sendResetEmailAPI(email, agent, domains);
                    if (res.message !== 'success') {
                        const desc = res.data?.description || res.message;
                        if (desc.includes('Maximum') || desc.includes('rate') || desc.includes('limit') || desc.includes('Try again')) {
                            const waitSec = 15 + (sendAttempt * 15);
                            log.warn(`[Thread ${threadId}] Rate limited, waiting ${waitSec}s... (${sendAttempt + 1}/3)`);
                            await sleep(waitSec * 1000);
                            continue;
                        }
                        // FALLBACK triggers: account not found in this region
                        if (desc.includes('not registered') || desc.includes('not found') || desc.includes('Phone number') || desc.includes('does not exist')) {
                            throw new Error(`FALLBACK_NEEDED: ${desc}`);
                        }
                        throw new Error(`API: ${desc}`);
                    }
                    log.ok(`[Thread ${threadId}] ${label} Reset email sent!`);
                    sendSuccess = true;
                    break;
                } catch (e) {
                    if (e.message.includes('FALLBACK_NEEDED')) throw e;
                    if ((e.message.includes('Maximum') || e.message.includes('rate') || e.message.includes('limit') || e.message.includes('Try again')) && sendAttempt < 2) {
                        const waitSec = 15 + (sendAttempt * 15);
                        log.warn(`[Thread ${threadId}] Rate limited, waiting ${waitSec}s... (${sendAttempt + 1}/3)`);
                        await sleep(waitSec * 1000);
                        continue;
                    }
                    throw e;
                }
            }
            if (!sendSuccess) throw new Error('Rate limit - max retries');

            // ============================================
            // STEP 2: Get reset link via REUSABLE browser page
            // ============================================
            const wsResult = await wsPromise;
            
            let resetLink = null;
            
            // [PATCH RESET_LINK_API_v2] Try API-first with the link from WebSocket
            if (wsResult.arrived && wsResult.link) {
                log.info(`[Thread ${threadId}] Email detected via WS, fetching via inbox API...`);
                
                // Fetch the message body via inbox<N> endpoint (parallel race)
                const RESET_LINK_REGEX = /https:\/\/www\.capcut\.com\/forget-password\?[^"'\s<>]+/i;
                const inboxCtx = wsResult.link.replace(/\//g, '%2F');
                
                const tryInbox = async (n) => {
                    try {
                        const res = await axios.get(`https://generator.email/inbox${n}/`, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.9',
                                'Referer': `https://generator.email/inbox${n}/`,
                                'Cookie': `inbox_n=${n}; inbox_ctx=${inboxCtx}`,
                                'sec-fetch-dest': 'document',
                                'sec-fetch-mode': 'navigate',
                                'sec-fetch-site': 'same-origin',
                                'upgrade-insecure-requests': '1'
                            },
                            timeout: 15000,
                            maxRedirects: 5,
                            validateStatus: () => true
                        });
                        const body = String(res.data || '');
                        const match = body.match(RESET_LINK_REGEX);
                        if (match) return match[0].replace(/&amp;/g, '&');
                        return null;
                    } catch (e) { return null; }
                };
                
                const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => tryInbox(n)));
                for (const link of results) {
                    if (link) { resetLink = link; break; }
                }
                
                // If API failed and we have a browser, fallback to it
                if (!resetLink && !useApiOnly && page) {
                    log.warn(`[Thread ${threadId}] API method failed, falling back to browser...`);
                    const emailUrl = `https://generator.email/${wsResult.link}`;
                    await page.goto(emailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await sleep(1000);
                    await closeAdsAndPopups(page);
                    
                    resetLink = await page.evaluate(() => {
                        const links = document.querySelectorAll('a');
                        for (const link of links) {
                            const href = link.href || '';
                            if (href.includes('forget-password') && href.includes('capcut')) return href;
                            if (href.includes('reset') && href.includes('capcut')) return href;
                        }
                        const allText = document.body.innerHTML;
                        const match = allText.match(/https:\/\/www\.capcut\.com\/forget-password\?[^"'\s<>]+/i);
                        if (match) return match[0].replace(/&amp;/g, '&');
                        return null;
                    });
                    
                    if (!resetLink) resetLink = await fetchResetLinkViaBrowser(page, email);
                }
            }
            
            // Fallback: WS didn't detect email → try API (in case email came late), then browser
            if (!resetLink) {
                log.info(`[Thread ${threadId}] Trying fast API method...`);
                resetLink = await fetchResetLinkViaAPI(email, 45000);

                // If API failed and we have a browser, fallback to browser polling
                if (!resetLink && !useApiOnly && page) {
                    const maxAttempts = wsResult.arrived ? 5 : 15;
                    for (let attempt = 0; attempt < maxAttempts; attempt++) {
                        log.info(`[Thread ${threadId}] Checking email (${attempt + 1}/${maxAttempts})...`);
                        resetLink = await fetchResetLinkViaBrowser(page, email);
                        if (resetLink) break;
                        await sleep(2000);
                    }
                }
            }

            if (!resetLink) throw new Error('Reset link not received in email');
            log.ok(`[Thread ${threadId}] Reset link found!`);

            // Extract code
            const urlObj = new URL(resetLink);
            const resetCode = urlObj.searchParams.get('code');
            if (!resetCode) throw new Error('No code in reset link');

            // ============================================
            // STEP 3: check_code API → get ticket (with proxy)
            // ============================================
            log.info(`[Thread ${threadId}] Verifying code via API...`);
            const encryptedEmail = Buffer.from(xorOperation(email)).toString('hex');
            const encryptedCode = Buffer.from(xorOperation(resetCode)).toString('hex');
            const verifyFp = generateVerifyFp();

            const checkRes = await axios.post(
                `${domains.login}/passport/web/email/check_code/`,
                new URLSearchParams({ mix_mode: '1', email: encryptedEmail, code: encryptedCode, type: '31', fixed_mix_mode: '1' }),
                {
                    params: { aid: APP_ID, account_sdk_source: 'web', sdk_version: '2.1.10-tiktok', language: 'en', verifyFp },
                    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Origin': 'https://www.capcut.com', 'Referer': 'https://www.capcut.com/' },
                    httpsAgent: agent, timeout: 15000
                }
            );
            
            if (checkRes.data?.message !== 'success') {
                const desc = checkRes.data?.data?.description || checkRes.data?.message;
                // FALLBACK triggers
                if (desc.includes('not registered') || desc.includes('not found') || desc.includes('Phone number')) {
                    throw new Error(`FALLBACK_NEEDED: ${desc}`);
                }
                throw new Error(`check_code failed: ${desc}`);
            }
            const ticket = checkRes.data?.data?.ticket;
            if (!ticket) throw new Error('No ticket returned');
            log.ok(`[Thread ${threadId}] Got ticket!`);

            // ============================================
            // STEP 4: reset_by_email_ticket API (with proxy)
            // ============================================
            log.info(`[Thread ${threadId}] Resetting password via API...`);
            const encryptedPwd = Buffer.from(xorOperation(newPassword)).toString('hex');

            for (let resetAttempt = 0; resetAttempt < 3; resetAttempt++) {
                const resetRes = await axios.post(
                    `${domains.login}/passport/web/password/reset_by_email_ticket/`,
                    new URLSearchParams({ mix_mode: '1', password: encryptedPwd, ticket, fixed_mix_mode: '1' }),
                    {
                        params: { aid: APP_ID, account_sdk_source: 'web', sdk_version: '2.1.10-tiktok', language: 'en', verifyFp },
                        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Origin': 'https://www.capcut.com', 'Referer': 'https://www.capcut.com/' },
                        httpsAgent: agent, timeout: 15000
                    }
                );
                if (resetRes.data?.message === 'success') {
                    log.ok(`[Thread ${threadId}] ${label} PASSWORD CHANGED: ${email} ⚡`);
                    return { success: true, email, changed: true };
                }
                const desc = resetRes.data?.data?.description || resetRes.data?.message;
                
                // FALLBACK triggers
                if (desc.includes('not registered') || desc.includes('not found') || desc.includes('Phone number')) {
                    throw new Error(`FALLBACK_NEEDED: ${desc}`);
                }
                
                if ((desc.includes('Maximum') || desc.includes('rate') || desc.includes('Try again')) && resetAttempt < 2) {
                    const waitSec = 15 + (resetAttempt * 15);
                    log.warn(`[Thread ${threadId}] Rate limited, waiting ${waitSec}s...`);
                    await sleep(waitSec * 1000);
                    continue;
                }
                throw new Error(`reset_by_ticket failed: ${desc}`);
            }
            throw new Error('Reset failed after retries');

        } catch (err) {
            lastError = err;
            
            // Check if we should try fallback
            if (err.message.includes('FALLBACK_NEEDED') && !isLastRegion) {
                log.warn(`[Thread ${threadId}] ⚠️ ${label}: Account not in this region, trying fallback...`);
                continue;  // Try next region
            }
            
            // No more regions to try or non-fallback error
            throw new Error(err.message.replace('FALLBACK_NEEDED: ', ''));
        }
    }
    
    throw lastError || new Error('All regions failed');
}

// Worker loop: ONE browser handles ALL emails for this worker
// regionMode: 'US', 'ROW', or 'AUTO'
async function cpWorkerLoop(workerId, queue, newPassword, proxy, stats, regionMode = 'AUTO', useApiOnly = false) {
    const userDataDir = path.join(__dirname, `user_data_cp_${workerId}_${Date.now()}`);
    let browser;
    
    try {
        // [PATCH RESET_LINK_API_v2] Skip browser launch in API-only mode
        let page = null;
        if (!useApiOnly) {
            fs.mkdirSync(userDataDir, { recursive: true });
            
            log.info(`[Worker ${workerId}] Launching browser (reused for all emails)...`);
            browser = await puppeteer.launch({
                executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                headless: "new",
                defaultViewport: null,
                userDataDir,
                args: ["--lang=en-US", "--disable-blink-features=AutomationControlled", "--no-sandbox", "--window-size=1280,800", "--window-position=-9999,-9999"],
                ignoreDefaultArgs: ['--enable-automation']
            });
            
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        } else {
            log.info(`[Worker ${workerId}] ⚡ Fast API mode — no browser`);
        }
        
        // Process emails from queue one by one
        while (queue.length > 0) {
            const email = queue.shift();
            if (!email) break;
            
            const threadId = ++stats.threadCounter;
            const MAX_RETRIES = 2; // retry up to 2 times for transient errors
            let succeeded = false;
            
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 0) {
                        log.warn(`[Thread ${threadId}] Retry ${attempt}/${MAX_RETRIES}: ${email}`);
                        await sleep(2000); // small delay before retry
                    }
                    
                    // Pass regionMode + useApiOnly to changeOnePassword
                    const result = await changeOnePassword(threadId, page, email, newPassword, proxy, regionMode, useApiOnly);
                    
                    if (result.success) {
                        stats.completed++;
                        log.ok(`Worker ${workerId} → ${email} PASSWORD CHANGED${attempt > 0 ? ` (retry ${attempt})` : ''} ✅`);
                        if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });
                        fs.appendFileSync('./results/password_changed.txt', `${email}:${newPassword}\n`);
                        succeeded = true;
                        break;
                    }
                } catch (e) {
                    const msg = e.message || '';
                    
                    // Retryable errors: network/proxy/TLS/timeout issues
                    const isRetryable = msg.includes('TLS') || msg.includes('socket') || msg.includes('ECONNRESET') 
                        || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('timeout')
                        || msg.includes('network') || msg.includes('disconnected') || msg.includes('EPIPE')
                        || msg.includes('EAI_AGAIN') || msg.includes('fetch failed') || msg.includes('Navigation')
                        || msg.includes('net::') || msg.includes('Reset link not received')
                        || msg.includes('expired') || msg.includes('incorrect')
                        || msg.includes('Proxy') || msg.includes('CONNECT') || msg.includes('connection ended')
                        || msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH') || msg.includes('ERR_');
                    
                    if (isRetryable && attempt < MAX_RETRIES) {
                        log.warn(`[Thread ${threadId}] ${email} → ${msg} (will retry)`);
                        continue; // retry
                    }
                    
                    // Final failure
                    stats.failed++;
                    log.err(`Worker ${workerId} → ${email} FAILED: ${msg}`);
                    fs.appendFileSync('./results/password_change_failed.txt', `${email} → ${msg}\n`);
                    break;
                }
            }
            
            stats.processed++;
            log.info(`📊 Progress: ${stats.processed}/${stats.total} (Active: ${stats.activeWorkers})`);
        }
    } catch (launchErr) {
        log.err(`Worker ${workerId} browser launch failed: ${launchErr.message}`);
    } finally {
        stats.activeWorkers--;
        if (browser) { try { await browser.close(); } catch(e) {} }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch(e) {}
    }
}

// Legacy wrapper for Worker Thread compatibility (menu mode action 4)
async function changePasswordBrowser(threadId, email, newPassword, proxy) {
    const userDataDir = path.join(__dirname, `user_data_reset_${threadId}_${Date.now()}`);
    let browser;
    
    try {
        fs.mkdirSync(userDataDir, { recursive: true });
        browser = await puppeteer.launch({
            executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            headless: "new", defaultViewport: null, userDataDir,
            args: ["--lang=en-US", "--disable-blink-features=AutomationControlled", "--no-sandbox", "--window-size=1280,800", "--window-position=-9999,-9999"],
            ignoreDefaultArgs: ['--enable-automation']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        return await changeOnePassword(threadId, page, email, newPassword, proxy);
    } catch (e) {
        log.err(`[Thread ${threadId}] FAILED: ${email} → ${e.message}`);
        return { success: false, email, error: e.message };
    } finally {
        if (browser) { try { await browser.close(); } catch(e) {} }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch(e) {}
    }
}

// === BOT ON TIME WORKER LOGIC ===
const BOT_API_KEY = '8586cabad3f6dfa551d888f421592fa9';
const BOT_API_BASE = 'https://temp.botontime.com/api.php';

async function createAndJoinBotOnTime(threadId, botEmail, password, proxy, autoJoin) {
    const agent = (proxy && proxy.proxyString) ? new HttpsProxyAgent(proxy.proxyString) : undefined;
    const domains = getDomains(proxy ? proxy.country : 'SG');

    if (autoJoin) {
        let linksCheck = [];
        try { linksCheck = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) {}
        if (linksCheck.length === 0) {
            log.err(`[Thread ${threadId}] links.txt is EMPTY!`);
            return { success: false };
        }
    }

    const deviceId = generateDeviceId();
    log.info(`[Thread ${threadId}] [BOT] Creating: ${botEmail} (${domains.name})`);

    // Step 1: Get current code (to know what's old)
    let oldCode = null, oldMsgId = 0;
    try {
        const codeRes = await axios.get(`${BOT_API_BASE}?action=code&email=${encodeURIComponent(botEmail)}&key=${BOT_API_KEY}`, { timeout: 10000 });
        if (codeRes.data?.code) {
            oldCode = codeRes.data.code;
            oldMsgId = codeRes.data?.message?.id || 0;
        }
    } catch (e) {}

    // Step 2: Send OTP
    const sendRes = await sendCode(botEmail, password, agent, domains);
    if (sendRes.message !== 'success') {
        log.err(`[Thread ${threadId}] [BOT] Failed to send OTP: ${botEmail} - ${sendRes?.data?.description || sendRes?.message}`);
        return { success: false };
    }
    log.ok(`[Thread ${threadId}] [BOT] OTP sent: ${botEmail}`);

    // Step 3: Wait for NEW code from bot on time
    let otp = null;
    const startTime = Date.now();
    const timeout = 60000;
    while (Date.now() - startTime < timeout) {
        try {
            const codeRes = await axios.get(`${BOT_API_BASE}?action=code&email=${encodeURIComponent(botEmail)}&key=${BOT_API_KEY}`, { timeout: 10000 });
            if ((codeRes.data?.ok || codeRes.data?.status === 'success') && codeRes.data?.code) {
                const newMsgId = codeRes.data?.message?.id || 0;
                const isNew = oldCode ? (codeRes.data.code !== oldCode || (oldMsgId && newMsgId !== oldMsgId)) : true;
                if (isNew) {
                    otp = codeRes.data.code;
                    break;
                }
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
    }

    if (!otp) {
        log.err(`[Thread ${threadId}] [BOT] No code received: ${botEmail}`);
        return { success: false };
    }
    log.ok(`[Thread ${threadId}] [BOT] Code received: ${otp}`);

    // Step 4: Register
    const otpHex = Buffer.from(xorOperation(otp)).toString('hex');
    const verifyFp = generateVerifyFp();
    const regRes = await regist(botEmail, password, otpHex, agent, domains, deviceId, verifyFp);
    if (regRes.data.message !== 'success') {
        log.err(`[Thread ${threadId}] [BOT] Registration failed: ${botEmail} - ${regRes.data?.data?.description || ''}`);
        return { success: false };
    }

    const userId = regRes.data?.data?.user_id_str || regRes.data?.data?.user_id || '';
    const userName = regRes.data?.data?.name || '';
    let session = regRes.session;

    log.ok(`[Thread ${threadId}] [BOT] Account created: ${botEmail}|${password} (${userName} | ID: ${userId})`);

    if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });
    fs.appendFileSync('./results/botontime_created.txt', `${botEmail}|${password}|${userName}|${userId}\n`);

    // Step 5: Auto Join
    if (!autoJoin) {
        return { success: true, email: botEmail, userName, userId };
    }

    const links = readLinks();
    let allLinksFull = true;
    const startIndex = readLinkPointer();

    for (let i = startIndex; i < links.length; i++) {
        const shortLink = links[i];
        try {
            let resolved = shortLink;
            if (domains.forceRegion === 'ID' || domains.regionParams === 'us') {
                try { resolved = await resolveShortLink(shortLink, agent); } catch (e) {}
            }
            const joinRes = await joinWorkspaceWithInvite(session, resolved, agent, domains);

            if (joinRes.status === 'success' || joinRes.status === 'already') {
                log.ok(`[Thread ${threadId}] [BOT] JOIN SUCCESS: ${botEmail} → ${shortLink} (link #${i + 1})`);
                const joinedFile = getRegionOutputPath(proxy?.country, 'joined');
                fs.appendFileSync(joinedFile, `${botEmail}|${password}\n`);
                appendLinkResult(shortLink, botEmail, password, userName, userId);
                writeLinkPointer(i);
                allLinksFull = false;
                return { success: true, joined: true, email: botEmail, userName, userId };
            } else if (joinRes.status === 'member_full') {
                log.warn(`[Thread ${threadId}] [BOT] 🔴 Link #${i + 1} FULL`);
                writeLinkPointer(i + 1);
                continue;
            } else if (joinRes.status === 'invalid_link') {
                log.warn(`[Thread ${threadId}] [BOT] ⚠️ Invalid link #${i + 1}`);
                continue;
            } else {
                log.err(`[Thread ${threadId}] [BOT] Join failed on link #${i + 1}: ${joinRes.status} - trying next...`);
                continue;
            }
        } catch (err) {
            log.err(`[Thread ${threadId}] [BOT] Error on link #${i + 1}: ${err.message} - trying next...`);
            continue;
        }
    }

    if (allLinksFull) {
        log.warn(`[Thread ${threadId}] [BOT] ⛔ ALL LINKS ARE FULL!`);
        return { success: true, joined: false, allFull: true, email: botEmail, userName, userId };
    }

    return { success: true, joined: false, email: botEmail, userName, userId };
}

// === MAIN WORKER LOGIC ===
async function createAndJoin(threadId, config, proxy, autoJoin) {
    const agent = (proxy && proxy.proxyString) ? new HttpsProxyAgent(proxy.proxyString) : undefined;

    // Get Domain Config based on Proxy Country
    const domains = getDomains(proxy ? proxy.country : 'US');

    // --- PRE-CHECK LINKS (if autoJoin) ---
    // User requested: "before doing create+join check firt if links.txt is filled"
    if (autoJoin) {
        let linksCheck = [];
        try {
            linksCheck = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean);
        } catch (e) {
            // file probably doesn't exist
        }

        if (linksCheck.length === 0) {
            log.err(`[Thread ${threadId}] links.txt is EMPTY! Stopping process.`);
            return { success: false, error: 'links.txt is empty' };
        }
    }

    const password = config.password;
    const domain = `${Math.random().toString(36).substring(2, 5)}.${config.domains[Math.floor(Math.random() * config.domains.length)]}`;
    const username = generateRandomUsername();
    const email = `${username}@${domain}`;

    const deviceId = generateDeviceId(); // Generate early for regist

    log.info(`[Thread ${threadId}] Creating account: ${email} (${domains.name})`);

    // Check email
    const check = await checkEmail(email, agent, domains);
    if (check.data.is_registered !== 0) {
        log.warn(`[Thread ${threadId}] Email already registered: ${email}`);
        return { success: false };
    }

    // Send OTP
    const sendRes = await sendCode(email, password, agent, domains);
    if (sendRes.message !== 'success') {
        log.err(`[Thread ${threadId}] Failed to send OTP: ${email}`);
        return { success: false };
    }

    // Get OTP
    let otp = null;
    for (let i = 0; i < 15; i++) {
        otp = await getVerificationCode(email);
        if (otp) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!otp) {
        log.err(`[Thread ${threadId}] OTP not received: ${email}`);
        return { success: false };
    }

    // Register
    const otpHex = Buffer.from(xorOperation(otp)).toString('hex');
    const verifyFp = generateVerifyFp(); // Generate FP for regist
    const regRes = await regist(email, password, otpHex, agent, domains, deviceId, verifyFp);
    if (regRes.data.message !== 'success') {
        log.err(`[Thread ${threadId}] Registration failed: ${email}`);
        return { success: false };
    }

    // Extract user_id and display name from registration response
    const userId = regRes.data?.data?.user_id_str || regRes.data?.data?.user_id || '';
    const userName = regRes.data?.data?.name || '';

    // Capture all cookies (cookie string) immediately from registration
    let session = regRes.session;

    log.ok(`[Thread ${threadId}] Account created: ${email}|${password} (${userName} | ID: ${userId})`);

    // --- AUTO JOIN (hanya jika dipilih) ---
    if (!autoJoin) {
        log.info(`[Thread ${threadId}] Create only mode - not joining`);
        // Write to region-specific created file (with user info)
        const createdFile = getRegionOutputPath(proxy?.country, 'created');
        fs.appendFileSync(createdFile, `${email}|${password}|${userName}|${userId}\n`);
        return { success: true, email, password, joined: false, country: proxy?.country, userId, userName };
    }

    const links = readLinks();
    // Double check just in case file changed mid-run, but we already pre-checked
    if (links.length === 0) {
        log.warn(`[Thread ${threadId}] No links to join`);
        return { success: true, email, password, joined: false };
    }

    // Generate pseudo device ID for this thread/account
    // const deviceId = generateDeviceId(); // Already generated above

    // REMOVED REDUNDANT LOGIN CALL (caused rate limits)
    // const session = await loginCapcut(email, password, agent, domains, deviceId);

    if (!session) {
        log.warn(`[Thread ${threadId}] Session not found from registration, trying manual login...`);
        try {
            // Only login if registration didn't give us a session (fallback)
            session = await loginCapcut(email, password, agent, domains, deviceId);
        } catch (e) {
            log.err(`[Thread ${threadId}] Login fallback failed: ${e.message}`);
            return { success: true, email, password, joined: false };
        }
    }

    log.info(`[Thread ${threadId}] Ready to join workspace...`);

    // === SMART POINTER: Start from last known good link ===
    const startIndex = readLinkPointer();
    if (startIndex > 0) {
        log.info(`[Thread ${threadId}] Skipping to link #${startIndex + 1} (pointer)`);
    }

    let allLinksFull = true; // Track if ALL links are full

    for (let i = startIndex; i < links.length; i++) {
        const shortLink = links[i];
        try {
            let resolved = shortLink;
            if (domains.forceRegion === 'ID' || domains.regionParams === 'us') {
                try {
                    resolved = await resolveShortLink(shortLink, agent);
                } catch (e) {
                    log.warn(`[Thread ${threadId}] Link resolution failed, trying original: ${e.message}`);
                }
            }

            const joinRes = await joinWorkspaceWithInvite(session, resolved, agent, domains);

            if (joinRes.status === 'success') {
                log.ok(`[Thread ${threadId}] JOIN SUCCESS: ${email} → ${shortLink} (link #${i + 1})`);

                // Write to region-specific joined file (email|password only)
                const joinedFile = getRegionOutputPath(proxy?.country, 'joined');
                fs.appendFileSync(joinedFile, `${email}|${password}\n`);

                // Write to per-link results file (with user info)
                appendLinkResult(shortLink, email, password, userName, userId);

                // Update pointer to this link (it's still accepting)
                writeLinkPointer(i);

                allLinksFull = false;
                return { success: true, email, password, joined: true, country: proxy?.country, joinedLink: shortLink, userId, userName };
            } else if (joinRes.status === 'already') {
                log.info(`[Thread ${threadId}] Already in workspace: ${email}`);
                const joinedFile = getRegionOutputPath(proxy?.country, 'joined');
                fs.appendFileSync(joinedFile, `${email}|${password}\n`);
                appendLinkResult(shortLink, email, password, userName, userId);
                writeLinkPointer(i);
                allLinksFull = false;
                return { success: true, email, password, joined: true, country: proxy?.country, joinedLink: shortLink, userId, userName };
            } else if (joinRes.status === 'member_full') {
                log.warn(`[Thread ${threadId}] 🔴 Link #${i + 1} FULL: ${shortLink}`);
                // Move pointer to next link
                writeLinkPointer(i + 1);
                continue;
            } else if (joinRes.status === 'invalid_link') {
                log.warn(`[Thread ${threadId}] ⚠️ Link #${i + 1} invalid: ${shortLink}`);
                continue;
            } else {
                log.err(`[Thread ${threadId}] Join failed on link #${i + 1}: ${joinRes.status} - trying next link...`);
                continue;
            }
        } catch (err) {
            log.err(`[Thread ${threadId}] Error on link #${i + 1}: ${err.message} - trying next link...`);
            continue;
        }
    }

    if (allLinksFull) {
        log.warn(`[Thread ${threadId}] ⛔ ALL LINKS ARE FULL! No workspace available.`);
        return { success: true, email, password, joined: false, allFull: true, country: proxy?.country };
    }

    log.warn(`[Thread ${threadId}] Failed to join any workspace`);
    return { success: true, email, password, joined: false, country: proxy?.country };
}

// === JOIN ONLY: READ ACCOUNTS ===
function readJoinOnlyAccounts() {
    const method1Path = './join_only/method1.txt';
    const method2Path = './join_only/method2.txt';

    let result = { method1: [], method2: [] };

    // Method 1: password: + emails
    try {
        const content = fs.readFileSync(method1Path, 'utf8').trim();
        const lines = content.split(/\r?\n/).filter(Boolean);
        let password = '';
        let emails = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith('password:')) {
                password = trimmed.split(':').slice(1).join(':').trim();
            } else if (trimmed.includes('@')) {
                emails.push(trimmed);
            }
        }
        if (password && emails.length > 0) {
            for (const email of emails) {
                result.method1.push({ email, password });
            }
        }
    } catch (e) {}

    // Method 2: email|password per line
    try {
        const content = fs.readFileSync(method2Path, 'utf8').trim();
        const lines = content.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.includes('|') && trimmed.includes('@')) {
                const parts = trimmed.split('|');
                result.method2.push({ email: parts[0].trim(), password: parts[1].trim() });
            }
        }
    } catch (e) {}

    return result;
}

// === CHANGE PASSWORD: READ ACCOUNTS ===
function readChangePasswordAccounts() {
    const filePath = './change_password/accounts.txt';
    try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        const lines = content.split(/\r?\n/).filter(Boolean);
        let newPassword = '';
        let emails = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith('new_password:')) {
                newPassword = trimmed.split(':').slice(1).join(':').trim();
            } else if (trimmed.includes('@')) {
                // Support: email|oldpass or email:oldpass — just take the email
                emails.push(trimmed.split(/[|]/)[0].split(':')[0].trim());
            }
        }

        return { newPassword, emails };
    } catch (e) {
        return { newPassword: '', emails: [] };
    }
}

// === JOIN ONLY: WORKER LOGIC ===
// regionMode: 'US', 'ROW', or 'AUTO' (tries both)
async function joinOnly(threadId, accountData, proxy, regionMode = 'AUTO') {
    const agent = (proxy && proxy.proxyString) ? new HttpsProxyAgent(proxy.proxyString) : undefined;
    const deviceId = generateDeviceId();
    const { email, password } = accountData;

    // Determine which regions to try based on mode
    let regionsToTry = [];
    if (regionMode === 'US') {
        regionsToTry = ['US'];
    } else if (regionMode === 'ROW') {
        regionsToTry = ['ROW'];
    } else {
        // AUTO mode: try ROW first (more common), then US
        regionsToTry = ['ROW', 'US'];
    }

    // In AUTO mode, use fewer attempts per region (3) to fail fast
    // In manual mode, use more attempts (15)
    const maxAttempts = regionMode === 'AUTO' ? 3 : 15;

    let session = null;
    let successDomains = null;
    let lastError = '';

    // Try login with each region until one works
    for (const region of regionsToTry) {
        const domains = region === 'US' ? getDomains('US') : getDomains('SG');
        const regionLabel = region === 'US' ? '🇺🇸 US' : '🌍 ROW';

        log.info(`[Thread ${threadId}] Trying ${regionLabel}: ${email}`);

        try {
            // Pass maxAttempts to loginCapcut
            session = await loginCapcut(email, password, agent, domains, deviceId, maxAttempts);
            if (session) {
                successDomains = domains;
                log.ok(`[Thread ${threadId}] ✅ Login SUCCESS with ${regionLabel}: ${email}`);
                break;
            }
        } catch (e) {
            lastError = e.message;
            
            // Check if it's a WRONG_REGION error (user not found in this region)
            const isWrongRegion = e.message.includes('WRONG_REGION') || 
                                  e.message.includes('not found') || 
                                  e.message.includes('not exist');
            
            if (isWrongRegion) {
                log.warn(`[Thread ${threadId}] ⚠️ ${regionLabel}: Account not in this region`);
            } else {
                log.warn(`[Thread ${threadId}] ❌ ${regionLabel} failed: ${e.message}`);
            }
            
            // If AUTO mode and first region failed, try the next one
            if (regionMode === 'AUTO' && regionsToTry.indexOf(region) < regionsToTry.length - 1) {
                log.info(`[Thread ${threadId}] 🔄 Switching to other region...`);
                continue;
            }
        }
    }

    if (!session || !successDomains) {
        log.err(`[Thread ${threadId}] Login failed on all regions: ${email}`);
        fs.appendFileSync('./results/join_only_failed.txt', `${email}|${password}|LOGIN_FAILED:${lastError}\n`);
        return { success: false, error: `Login failed: ${lastError}`, email };
    }

    // Now try to join workspace
    const links = readLinks();
    if (links.length === 0) {
        log.err(`[Thread ${threadId}] links.txt is empty`);
        return { success: false, error: 'No links', email };
    }

    // === SMART POINTER: Start from last known good link ===
    const startIndex = readLinkPointer();
    if (startIndex > 0) {
        log.info(`[Thread ${threadId}] Skipping to link #${startIndex + 1} (pointer)`);
    }

    let allLinksFull = true;

    for (let i = startIndex; i < links.length; i++) {
        const shortLink = links[i];
        try {
            let resolved = shortLink;
            if (successDomains.forceRegion === 'ID' || successDomains.regionParams === 'us') {
                try {
                    resolved = await resolveShortLink(shortLink, agent);
                } catch (e) {
                    log.warn(`[Thread ${threadId}] Link resolution failed: ${e.message}`);
                }
            }

            const joinRes = await joinWorkspaceWithInvite(session, resolved, agent, successDomains);

            if (joinRes.status === 'success') {
                log.ok(`[Thread ${threadId}] JOIN OK: ${email} → link #${i + 1}`);
                fs.appendFileSync('./results/join_only_success.txt', `${email}|${password}\n`);
                appendLinkResult(shortLink, email, password, '', '');
                writeLinkPointer(i);
                allLinksFull = false;
                return { success: true, email, joined: true, country: proxy?.country, joinedLink: shortLink };
            } else if (joinRes.status === 'already') {
                log.info(`[Thread ${threadId}] Already joined: ${email}`);
                fs.appendFileSync('./results/join_only_success.txt', `${email}|${password}|ALREADY\n`);
                appendLinkResult(shortLink, email, password, '', '');
                writeLinkPointer(i);
                allLinksFull = false;
                return { success: true, email, joined: true, country: proxy?.country, joinedLink: shortLink };
            } else if (joinRes.status === 'member_full') {
                log.warn(`[Thread ${threadId}] 🔴 Link #${i + 1} FULL: ${shortLink}`);
                writeLinkPointer(i + 1);
                continue;
            } else if (joinRes.status === 'invalid_link') {
                log.warn(`[Thread ${threadId}] ⚠️ Link #${i + 1} invalid: ${shortLink}`);
                continue;
            } else {
                log.err(`[Thread ${threadId}] Join failed on link #${i + 1}: ${joinRes.status} - trying next link...`);
                continue;
            }
        } catch (err) {
            log.err(`[Thread ${threadId}] Error on link #${i + 1}: ${err.message} - trying next link...`);
            continue;
        }
    }

    if (allLinksFull) {
        log.warn(`[Thread ${threadId}] ⛔ ALL LINKS ARE FULL!`);
        fs.appendFileSync('./results/join_only_failed.txt', `${email}|${password}|ALL_LINKS_FULL\n`);
        return { success: false, email, joined: false, allFull: true, country: proxy?.country };
    }

    log.warn(`[Thread ${threadId}] Could not join: ${email}`);
    fs.appendFileSync('./results/join_only_failed.txt', `${email}|${password}|JOIN_FAILED\n`);
    return { success: false, email, joined: false, country: proxy?.country };
}

// === CHANGE PASSWORD: WORKER LOGIC ===
async function changePasswordWorker(threadId, accountData, proxy) {
    const { email, newPassword } = accountData;

    try {
        const result = await changePasswordBrowser(threadId, email, newPassword, proxy);

        if (result.success) {
            fs.appendFileSync('./results/password_changed.txt', `${email}|${newPassword}\n`);
            return { success: true, email, changed: true, country: proxy?.country };
        } else {
            fs.appendFileSync('./results/password_change_failed.txt', `${email}|ERROR:${result.error}\n`);
            return { success: false, error: result.error, email };
        }
    } catch (err) {
        log.err(`[Thread ${threadId}] Change error: ${email} → ${err.message}`);
        fs.appendFileSync('./results/password_change_failed.txt', `${email}|ERROR:${err.message}\n`);
        return { success: false, error: err.message, email };
    }
}

// === MAIN THREAD ===
if (isMainThread) {
    // Direct change password shortcut (change.bat)
    if (process.argv.includes('--direct-change')) {
        (async () => {
            console.clear();
            console.log(chalk.cyan('╔═══════════════════════════════════════╗'));
            console.log(chalk.cyan('║  CapCut Password Changer ⚡           ║'));
            console.log(chalk.cyan('╚═══════════════════════════════════════╝\n'));

            const cpData = readChangePasswordAccounts();
            if (cpData.emails.length === 0) {
                console.log(chalk.red('\n❌ No accounts found!'));
                console.log(chalk.yellow('Put accounts in: change_password/accounts.txt'));
                console.log(chalk.gray('\n  Format:'));
                console.log(chalk.gray('  new_password: MyNewPassword123'));
                console.log(chalk.gray('  email1@domain.com'));
                console.log(chalk.gray('  email2@domain.com'));
                process.exit(1);
            }
            if (!cpData.newPassword) {
                console.log(chalk.red('\n❌ new_password not set in change_password/accounts.txt!'));
                process.exit(1);
            }

            console.log(chalk.cyan(`═══════════════════════════════════════`));
            console.log(chalk.white(`  CHANGE PASSWORD`));
            console.log(chalk.cyan(`═══════════════════════════════════════`));
            console.log(chalk.green(`  📧 Accounts: ${cpData.emails.length}`));
            console.log(chalk.green(`  🔑 New Password: ${cpData.newPassword}`));
            console.log(chalk.gray(`  ⚡ WebSocket + API + Shared Browser (Fast!)`));
            console.log(chalk.cyan(`═══════════════════════════════════════\n`));

            const confirmCP = readlineSync.question(chalk.yellow('[?] Continue? (y/n): '));
            if (confirmCP.toLowerCase() !== 'y') process.exit(0);

            // [PATCH RESET_LINK_API_v2] Ask if user wants Fast API mode (no browser)
            console.log(chalk.cyan(`\n═══════════════════════════════════════`));
            console.log(chalk.white(`  ⚡ SPEED MODE`));
            console.log(chalk.cyan(`═══════════════════════════════════════`));
            console.log(chalk.green(`  1. ⚡ Fast API only (no browser — fastest)`));
            console.log(chalk.yellow(`  2. 🛡️ API + Browser fallback (safest)`));
            console.log(chalk.cyan(`═══════════════════════════════════════`));
            const speedModeStr2 = readlineSync.question(chalk.yellow('[?] Select mode (1/2, default=1): ')).trim();
            const useApiOnly2 = speedModeStr2 !== '2';
            console.log(chalk.green(`✓ Selected: ${useApiOnly2 ? '⚡ Fast API only' : '🛡️ API + Browser fallback'}\n`));

            // Load and validate proxies
            const proxies = readProxies();
            const validProxies = [];
            console.log(chalk.yellow('\n⏳ Checking proxies...\n'));
            for (const p of proxies) {
                try {
                    const res = await axios.get('https://ipinfo.io/json', {
                        httpsAgent: new HttpsProxyAgent(p.proxyString),
                        timeout: 10000
                    });
                    validProxies.push({ ...p, ip: res.data.ip, country: res.data.country });
                    log.ok(`Proxy valid: ${res.data.ip} (${res.data.country})`);
                } catch (e) {
                    log.warn(`Proxy failed: ${p.proxyString}`);
                }
            }

            if (validProxies.length === 0) {
                console.log(chalk.yellow('\n⚠️ No proxies found, checking direct connection...'));
                try {
                    const res = await axios.get('https://ipinfo.io/json', { timeout: 10000 });
                    validProxies.push({ proxyString: null, ip: res.data.ip, country: res.data.country });
                    log.warn(`Using direct IP: ${res.data.ip} (${res.data.country}) - Rate limits may apply!`);
                } catch (e) {
                    validProxies.push({ proxyString: null, ip: 'Unknown', country: 'US' });
                }
            }

            console.log(chalk.green(`\n✅ ${validProxies.length} connection(s) ready.`));

            // Smart worker count: 3 per proxy, max 7
            const NUM_WORKERS = Math.max(1, Math.min(validProxies.length * 5, 10));
            console.log(chalk.cyan(`  ⚡ Launching ${NUM_WORKERS} ${useApiOnly2 ? 'API workers (no browser)' : 'shared browsers (each reused for all emails)'}\n`));

            // Shared queue and stats
            const cpQueue = [...cpData.emails]; // simple array of emails
            const stats = { 
                completed: 0, failed: 0, processed: 0, 
                total: cpData.emails.length, 
                activeWorkers: NUM_WORKERS,
                threadCounter: 0
            };

            if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });

            // Launch all workers in parallel — each has its own persistent browser (or none in API-only mode)
            const workerPromises = [];
            for (let i = 0; i < NUM_WORKERS; i++) {
                const proxy = validProxies[i % validProxies.length];
                workerPromises.push(cpWorkerLoop(i + 1, cpQueue, cpData.newPassword, proxy, stats, 'AUTO', useApiOnly2));
            }

            // Wait for all workers to finish
            await Promise.all(workerPromises);

            console.log(chalk.cyan('\n═══════════════════════════════════════'));
            console.log(chalk.white('        CHANGE PASSWORD COMPLETED'));
            console.log(chalk.cyan('═══════════════════════════════════════'));
            log.ok(`✅ Changed: ${stats.completed}`);
            if (stats.failed > 0) log.err(`❌ Failed: ${stats.failed}`);
            log.info(`📊 Total: ${stats.total} accounts`);
            if (stats.completed > 0) console.log(chalk.gray(`\n📁 Results saved to: results/password_changed.txt`));
            if (stats.failed > 0) console.log(chalk.gray(`📁 Failed saved to: results/password_change_failed.txt`));
            console.log(chalk.cyan('═══════════════════════════════════════\n'));
            readlineSync.question('Press Enter to exit...');
            process.exit(0);
        })();
        return; // Skip normal menu
    }

    (async () => {
        const masterConfig = readConfig();

        while (true) {
            console.clear();
            console.log(chalk.cyan('╔═══════════════════════════════════════╗'));
            console.log(chalk.cyan('║  CapCut Auto (Multi-Region) v3.2      ║'));
            console.log(chalk.cyan('║  + User Friendly Menu                 ║'));
            console.log(chalk.cyan('╚═══════════════════════════════════════╝\n'));

            // === DOMAIN SELECTION (If Multi) ===
            let activeConfig = JSON.parse(JSON.stringify(masterConfig)); // Deep copy for this iteration

            if (masterConfig.domains && masterConfig.domains.length > 1) {
                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.white('          DOMAIN SELECTION'));
                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.yellow('  1. Random (Use All)'));
                masterConfig.domains.forEach((d, i) => {
                    console.log(chalk.yellow(`  ${i + 2}. ${d}`));
                });
                console.log(chalk.cyan('═══════════════════════════════════════\n'));

                let domainChoice;
                while (true) {
                    domainChoice = readlineSync.question(chalk.green(`[?] Select Domain (1-${masterConfig.domains.length + 1}): `));
                    const choiceInt = parseInt(domainChoice);
                    if (!isNaN(choiceInt) && choiceInt >= 1 && choiceInt <= masterConfig.domains.length + 1) break;
                    console.log(chalk.red('❌ Invalid selection!\n'));
                }

                if (domainChoice !== '1') {
                    const selectedDomain = masterConfig.domains[parseInt(domainChoice) - 2];
                    activeConfig.domains = [selectedDomain];
                    console.log(chalk.green(`\n✓ Selected Domain: ${selectedDomain}`));
                    await new Promise(r => setTimeout(r, 1000)); // Brief pause to see selection
                } else {
                    console.log(chalk.green('\n✓ Selected: Random (All Domains)'));
                    await new Promise(r => setTimeout(r, 1000));
                }
                console.clear();
            }

            let regionChoice;
            
            // Check for command line argument (us/row)
            const cmdArg = process.argv[2]?.toLowerCase();
            if (cmdArg === 'us') {
                regionChoice = '1';
            } else if (cmdArg === 'row' || cmdArg === 'non') {
                regionChoice = '2';
            } else {
                // Show menu only if no command line argument
                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.white('          REGION SELECTION'));
                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.yellow('  1. US'));
                console.log(chalk.yellow('  2. NON US (ROW)'));
                console.log(chalk.cyan('═══════════════════════════════════════\n'));

                while (true) {
                    regionChoice = readlineSync.question(chalk.green('[?] Select Region (1/2): '));
                    if (regionChoice === '1' || regionChoice === '2') break;
                    console.log(chalk.red('❌ Invalid! Select 1 or 2.\n'));
                }
            }

            const isUS = regionChoice === '1';
            let regionLabel = 'US'; // default, updated if ROW detected
            let validProxies = [];

            // --- PROXY LOADING WITH SMART FILTERING ---
            const allProxies = readProxies();
            
            // Filter proxies based on region selection
            let filteredProxies;
            if (isUS) {
                // US: Only use proxies with __cr.us
                filteredProxies = allProxies.filter(p => p.proxyString && p.proxyString.includes('__cr.us'));
                console.log(chalk.yellow('\n⏳ Checking US proxies (__cr.us)...\n'));
                
                if (filteredProxies.length === 0) {
                    console.log(chalk.red('\n❌ No US proxies found in proxies.json!'));
                    console.log(chalk.yellow('Add proxies with __cr.us in proxies.json'));
                    console.log(chalk.gray('Example: {"proxyString":"http://....__cr.us:....@gw.dataimpulse.com:823"}'));
                    readlineSync.question('\nPress ENTER to return...');
                    continue;
                }
            } else {
                // ROW: Use proxies WITHOUT __cr.us (any other country)
                filteredProxies = allProxies.filter(p => p.proxyString && !p.proxyString.includes('__cr.us'));
                console.log(chalk.yellow('\n⏳ Checking ROW proxies (non-US)...\n'));
                
                if (filteredProxies.length === 0) {
                    console.log(chalk.yellow('⚠️ No ROW proxies found, will try direct connection...'));
                }
            }

            // Validate filtered proxies
            for (const p of filteredProxies) {
                try {
                    const res = await axios.get('https://ipinfo.io/json', {
                        httpsAgent: new HttpsProxyAgent(p.proxyString),
                        timeout: 10000
                    });
                    validProxies.push({ ...p, ip: res.data.ip, country: res.data.country });
                    log.ok(`Proxy valid: ${res.data.ip} (${res.data.country})`);
                    if (!isUS) {
                        regionLabel = `ROW (${res.data.country})`;
                    }
                } catch (e) {
                    log.warn(`Proxy failed: ${p.proxyString.substring(0, 50)}...`);
                }
            }

            // Handle results
            if (isUS) {
                if (validProxies.length === 0) {
                    console.log(chalk.red('\n❌ No valid US proxies found!'));
                    console.log(chalk.yellow('Press ENTER to return to Region Selection...'));
                    readlineSync.question();
                    continue;
                }
                console.log(chalk.green(`\n✅ ${validProxies.length} valid US proxies found.`));
            } else {
                // ROW: Fallback to direct connection if no proxies work
                if (validProxies.length === 0) {
                    console.log(chalk.yellow('\n⚠️ No ROW proxies work, using direct connection...\n'));
                    try {
                        const res = await axios.get('https://ipinfo.io/json', { timeout: 10000 });
                        const detectedCountry = res.data.country || 'UNKNOWN';
                        log.ok(`Detected Region: ${detectedCountry} (IP: ${res.data.ip})`);
                        validProxies.push({ proxyString: null, ip: res.data.ip, country: detectedCountry });
                        regionLabel = `ROW (${detectedCountry})`;
                    } catch (e) {
                        console.log(chalk.red(`\n❌ Failed to detect region: ${e.message}`));
                        validProxies.push({ proxyString: null, ip: 'Unknown', country: 'SG' });
                        regionLabel = 'ROW (Unknown)';
                    }
                } else {
                    console.log(chalk.green(`\n✅ ${validProxies.length} valid ROW proxies found.`));
                }
            }

            // === ACTION MENU ===
            while (true) {
                console.clear();
                console.log(chalk.cyan(`╔═══════════════════════════════════════╗`));
                console.log(chalk.cyan(`║  SELECTED REGION: ${regionLabel.padEnd(19)} ║`));
                console.log(chalk.cyan(`╚═══════════════════════════════════════╝\n`));

                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.white(`          ACTION MENU (${regionLabel})`));
                console.log(chalk.cyan('═══════════════════════════════════════'));
                console.log(chalk.yellow(`  1. CREATE BASIC ${regionLabel}`));
                console.log(chalk.yellow(`  2. CREATE + JOIN ${regionLabel}`));
                console.log(chalk.yellow(`  3. JOIN ONLY (Existing Accounts)`));
                console.log(chalk.yellow(`  4. CHANGE PASSWORD`));
                console.log(chalk.yellow(`  5. CREATE via Bot On Time`));
                console.log(chalk.yellow(`  6. Back to Region Selection`));
                console.log(chalk.cyan('═══════════════════════════════════════\n'));

                let actionChoice = readlineSync.question(chalk.green('[?] Select Action (1/2/3/4/5/6): '));

                if (actionChoice === '6') {
                    break; // Break inner loop, goes back to region selection
                }

                // === JOIN ONLY MODE ===
                if (actionChoice === '3') {
                    const joinData = readJoinOnlyAccounts();
                    const has1 = joinData.method1.length > 0;
                    const has2 = joinData.method2.length > 0;

                    if (!has1 && !has2) {
                        console.log(chalk.red('\n❌ No accounts found!'));
                        console.log(chalk.yellow('Put accounts in:'));
                        console.log(chalk.gray('  join_only/method1.txt (password: + emails)'));
                        console.log(chalk.gray('  join_only/method2.txt (email|password per line)'));
                        readlineSync.question('\nPress Enter to return...');
                        continue;
                    }

                    // Check links.txt
                    try {
                        const linksCheck = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean);
                        if (linksCheck.length === 0) {
                            console.log(chalk.red('\n❌ links.txt is empty! Add group links first.'));
                            readlineSync.question('Press Enter to return...');
                            continue;
                        }
                    } catch (e) {
                        console.log(chalk.red('\n❌ links.txt not found!'));
                        readlineSync.question('Press Enter to return...');
                        continue;
                    }

                    let accounts = [];

                    if (has1 && has2) {
                        console.log(chalk.cyan('\n═══════════════════════════════════════'));
                        console.log(chalk.white('  Both files have accounts:'));
                        console.log(chalk.yellow(`  1. method1.txt (${joinData.method1.length} accounts)`));
                        console.log(chalk.yellow(`  2. method2.txt (${joinData.method2.length} accounts)`));
                        console.log(chalk.yellow(`  3. Use both (${joinData.method1.length + joinData.method2.length} accounts)`));
                        console.log(chalk.cyan('═══════════════════════════════════════'));
                        const methodChoice = readlineSync.question(chalk.green('[?] Select (1/2/3): '));
                        if (methodChoice === '1') accounts = joinData.method1;
                        else if (methodChoice === '2') accounts = joinData.method2;
                        else accounts = [...joinData.method1, ...joinData.method2];
                    } else if (has1) {
                        accounts = joinData.method1;
                        console.log(chalk.green(`\n✅ Loaded ${accounts.length} accounts from method1.txt`));
                    } else {
                        accounts = joinData.method2;
                        console.log(chalk.green(`\n✅ Loaded ${accounts.length} accounts from method2.txt`));
                    }

                    // === NEW: Region Selection for Join Only ===
                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('  🌍 ACCOUNT REGION SELECTION'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    console.log(chalk.yellow('  1. 🇺🇸 US Only (Accounts created in US)'));
                    console.log(chalk.yellow('  2. 🌍 NON-US Only (Accounts created outside US)'));
                    console.log(chalk.green('  3. 🔄 AUTO-DETECT (Try both - Recommended)'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    console.log(chalk.gray('  💡 If unsure, choose option 3 (AUTO)'));
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    let joinRegionMode = 'AUTO';
                    while (true) {
                        const regionChoice = readlineSync.question(chalk.green('[?] Select Region Mode (1/2/3): '));
                        if (regionChoice === '1') {
                            joinRegionMode = 'US';
                            console.log(chalk.green('\n✓ Selected: 🇺🇸 US Only'));
                            break;
                        } else if (regionChoice === '2') {
                            joinRegionMode = 'ROW';
                            console.log(chalk.green('\n✓ Selected: 🌍 NON-US Only'));
                            break;
                        } else if (regionChoice === '3') {
                            joinRegionMode = 'AUTO';
                            console.log(chalk.green('\n✓ Selected: 🔄 AUTO-DETECT (Will try both regions)'));
                            break;
                        }
                        console.log(chalk.red('❌ Invalid! Select 1, 2, or 3.\n'));
                    }

                    console.log(chalk.cyan(`\n═══════════════════════════════════════`));
                    console.log(chalk.white(`  JOIN ONLY: ${accounts.length} accounts`));
                    console.log(chalk.white(`  Region Mode: ${joinRegionMode === 'AUTO' ? '🔄 AUTO-DETECT' : joinRegionMode === 'US' ? '🇺🇸 US' : '🌍 NON-US'}`));
                    console.log(chalk.cyan(`  Max 10 workers at a time`));
                    console.log(chalk.cyan(`═══════════════════════════════════════\n`));

                    // Worker queue for join only
                    const MAX_JOIN_WORKERS = 10;
                    let joinActiveWorkers = 0;
                    let joinCompleted = 0;
                    let joinFailed = 0;
                    let joinProcessed = 0;
                    let joinQueue = [...accounts];
                    const joinPromises = [];

                    const spawnJoinWorker = (workerId, account) => {
                        return new Promise((resolve) => {
                            const worker = new Worker(__filename, {
                                workerData: {
                                    threadId: workerId,
                                    mode: 'joinOnly',
                                    accountData: account,
                                    proxy: validProxies[workerId % validProxies.length],
                                    regionMode: joinRegionMode  // NEW: Pass region mode
                                }
                            });

                            joinActiveWorkers++;

                            worker.on('message', (res) => {
                                if (res.success && res.joined) {
                                    log.ok(`Worker ${res.threadId} → ${res.email} JOINED`);
                                    joinCompleted++;
                                } else {
                                    log.err(`Worker ${res.threadId} → ${res.email} FAILED`);
                                    joinFailed++;
                                }

                                joinActiveWorkers--;
                                joinProcessed++;
                                log.info(`📊 Join Progress: ${joinProcessed}/${accounts.length} (Active: ${joinActiveWorkers})`);
                                resolve(res);

                                if (joinQueue.length > 0) {
                                    const nextAccount = joinQueue.shift();
                                    const nextId = joinProcessed + joinActiveWorkers + 1;
                                    const next = spawnJoinWorker(nextId, nextAccount);
                                    joinPromises.push(next);
                                }
                            });

                            worker.on('error', (err) => {
                                log.err(`Worker ${workerId} error: ${err.message}`);
                                joinActiveWorkers--;
                                joinProcessed++;
                                joinFailed++;
                                resolve({ success: false });

                                if (joinQueue.length > 0) {
                                    const nextAccount = joinQueue.shift();
                                    const nextId = joinProcessed + joinActiveWorkers + 1;
                                    const next = spawnJoinWorker(nextId, nextAccount);
                                    joinPromises.push(next);
                                }
                            });

                            worker.on('exit', () => {});
                        });
                    };

                    const initialJoinBatch = Math.min(accounts.length, MAX_JOIN_WORKERS);
                    for (let i = 0; i < initialJoinBatch; i++) {
                        const account = joinQueue.shift();
                        joinPromises.push(spawnJoinWorker(i + 1, account));
                    }

                    // Wait for all to finish
                    await new Promise((resolve) => {
                        const interval = setInterval(() => {
                            if (joinProcessed >= accounts.length) {
                                clearInterval(interval);
                                resolve();
                            }
                        }, 100);
                    });

                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('        JOIN ONLY COMPLETED'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    log.ok(`✅ Joined: ${joinCompleted}`);
                    if (joinFailed > 0) log.err(`❌ Failed: ${joinFailed}`);
                    log.info(`📊 Total: ${accounts.length} accounts`);
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    readlineSync.question('Press Enter to continue...');
                    continue;
                }

                // === CHANGE PASSWORD MODE ===
                if (actionChoice === '4') {
                    const cpData = readChangePasswordAccounts();

                    if (cpData.emails.length === 0) {
                        console.log(chalk.red('\n❌ No accounts found!'));
                        console.log(chalk.yellow('Put accounts in:'));
                        console.log(chalk.gray('  change_password/accounts.txt'));
                        console.log(chalk.gray('\n  Format:'));
                        console.log(chalk.gray('  new_password: MyNewPassword123'));
                        console.log(chalk.gray('  '));
                        console.log(chalk.gray('  email1@domain.com'));
                        console.log(chalk.gray('  email2@domain.com'));
                        readlineSync.question('\nPress Enter to return...');
                        continue;
                    }

                    if (!cpData.newPassword) {
                        console.log(chalk.red('\n❌ new_password not set in change_password/accounts.txt!'));
                        readlineSync.question('Press Enter to return...');
                        continue;
                    }

                    // === Region Selection for Change Password ===
                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('  🌍 ACCOUNT REGION SELECTION'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    console.log(chalk.yellow('  1. 🇺🇸 US Only (Accounts created in US)'));
                    console.log(chalk.yellow('  2. 🌍 NON-US Only (Accounts created outside US)'));
                    console.log(chalk.green('  3. 🔄 AUTO-DETECT (Try both with fallback)'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    console.log(chalk.gray('  💡 If unsure, choose option 3 (AUTO)'));
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    let cpRegionMode = 'AUTO';
                    while (true) {
                        const regionChoice = readlineSync.question(chalk.green('[?] Select Region Mode (1/2/3): '));
                        if (regionChoice === '1') {
                            cpRegionMode = 'US';
                            console.log(chalk.green('\n✓ Selected: 🇺🇸 US Only'));
                            break;
                        } else if (regionChoice === '2') {
                            cpRegionMode = 'ROW';
                            console.log(chalk.green('\n✓ Selected: 🌍 NON-US Only'));
                            break;
                        } else if (regionChoice === '3') {
                            cpRegionMode = 'AUTO';
                            console.log(chalk.green('\n✓ Selected: 🔄 AUTO-DETECT (Will try both regions)'));
                            break;
                        }
                        console.log(chalk.red('❌ Invalid! Select 1, 2, or 3.\n'));
                    }

                    console.log(chalk.cyan(`\n═══════════════════════════════════════`));
                    console.log(chalk.white(`  CHANGE PASSWORD`));
                    console.log(chalk.cyan(`═══════════════════════════════════════`));
                    console.log(chalk.green(`  📧 Accounts: ${cpData.emails.length}`));
                    console.log(chalk.green(`  🔑 New Password: ${cpData.newPassword}`));
                    console.log(chalk.green(`  🌍 Region Mode: ${cpRegionMode === 'AUTO' ? '🔄 AUTO-DETECT' : cpRegionMode === 'US' ? '🇺🇸 US' : '🌍 NON-US'}`));
                    console.log(chalk.gray(`  ⚡ WebSocket + API + Shared Browser (Fast!)`));
                    console.log(chalk.cyan(`═══════════════════════════════════════\n`));

                    const confirmCP = readlineSync.question(chalk.yellow('[?] Continue? (y/n): '));
                    if (confirmCP.toLowerCase() !== 'y') {
                        continue;
                    }

                    // [PATCH RESET_LINK_API_v2] Ask if user wants Fast API mode (no browser)
                    console.log(chalk.cyan(`\n═══════════════════════════════════════`));
                    console.log(chalk.white(`  ⚡ SPEED MODE`));
                    console.log(chalk.cyan(`═══════════════════════════════════════`));
                    console.log(chalk.green(`  1. ⚡ Fast API only (no browser — fastest)`));
                    console.log(chalk.yellow(`  2. 🛡️ API + Browser fallback (safest)`));
                    console.log(chalk.cyan(`═══════════════════════════════════════`));
                    const speedModeStr = readlineSync.question(chalk.yellow('[?] Select mode (1/2, default=1): ')).trim();
                    const useApiOnly = speedModeStr !== '2';
                    console.log(chalk.green(`✓ Selected: ${useApiOnly ? '⚡ Fast API only' : '🛡️ API + Browser fallback'}\n`));

                    // Smart worker count: 3 per proxy, max 7
                    const NUM_CP_WORKERS = Math.max(1, Math.min(validProxies.length * 5, 10));
                    console.log(chalk.cyan(`  ⚡ Launching ${NUM_CP_WORKERS} ${useApiOnly ? 'API workers (no browser)' : 'shared browsers'}\n`));

                    const cpQueue = [...cpData.emails];
                    const cpStats = { 
                        completed: 0, failed: 0, processed: 0, 
                        total: cpData.emails.length, 
                        activeWorkers: NUM_CP_WORKERS,
                        threadCounter: 0
                    };

                    if (!fs.existsSync('./results')) fs.mkdirSync('./results', { recursive: true });

                    const cpWorkerPromises = [];
                    for (let i = 0; i < NUM_CP_WORKERS; i++) {
                        const proxy = validProxies[i % validProxies.length];
                        // Pass regionMode + useApiOnly to cpWorkerLoop
                        cpWorkerPromises.push(cpWorkerLoop(i + 1, cpQueue, cpData.newPassword, proxy, cpStats, cpRegionMode, useApiOnly));
                    }
                    await Promise.all(cpWorkerPromises);

                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('        CHANGE PASSWORD COMPLETED'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    log.ok(`✅ Changed: ${cpStats.completed}`);
                    if (cpStats.failed > 0) log.err(`❌ Failed: ${cpStats.failed}`);
                    log.info(`📊 Total: ${cpStats.total} accounts`);
                    if (cpStats.completed > 0) {
                        console.log(chalk.gray(`\n📁 Results saved to: results/password_changed.txt`));
                    }
                    if (cpStats.failed > 0) {
                        console.log(chalk.gray(`📁 Failed saved to: results/password_change_failed.txt`));
                    }
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    readlineSync.question('Press Enter to continue...');
                    continue;
                }

                // === BOT ON TIME MODE ===
                if (actionChoice === '5') {
                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('     CREATE via Bot On Time'));
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    const BOT_API_KEY = '8586cabad3f6dfa551d888f421592fa9';
                    const BOT_API_BASE = 'https://temp.botontime.com/api.php';
                    const BOT_FOLDER = './botontime';

                    // Create folder if not exists
                    if (!fs.existsSync(BOT_FOLDER)) fs.mkdirSync(BOT_FOLDER, { recursive: true });

                    // Check for emails file
                    const emailsFile = `${BOT_FOLDER}/emails.txt`;
                    const domainsFile = `${BOT_FOLDER}/domains.txt`;

                    if (!fs.existsSync(emailsFile)) {
                        fs.writeFileSync(emailsFile, '# Put emails here - one per line\n# Example: ahmed92@gmail.com\n');
                        console.log(chalk.yellow(`📁 Created: ${emailsFile}`));
                        console.log(chalk.yellow('   Add your emails and run again.\n'));
                        readlineSync.question('Press Enter to continue...');
                        continue;
                    }

                    const botEmails = fs.readFileSync(emailsFile, 'utf8')
                        .split(/\r?\n/)
                        .map(l => l.trim())
                        .filter(l => l && !l.startsWith('#') && l.includes('@'));

                    if (botEmails.length === 0) {
                        console.log(chalk.red(`❌ No emails found in ${emailsFile}`));
                        readlineSync.question('Press Enter to continue...');
                        continue;
                    }

                    // Show domains if file exists
                    if (fs.existsSync(domainsFile)) {
                        const domains = fs.readFileSync(domainsFile, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
                        if (domains.length > 0) {
                            console.log(chalk.gray(`📋 Domains available: ${domains.join(', ')}`));
                        }
                    }

                    console.log(chalk.green(`📧 Found ${botEmails.length} email(s) in ${emailsFile}`));
                    console.log(chalk.gray(`   Password: ${activeConfig.password || 'capcut321'}\n`));

                    // Ask: Create only or Create + Join?
                    console.log(chalk.cyan('  1. Create Only'));
                    console.log(chalk.cyan('  2. Create + Join'));
                    const botMode = readlineSync.question(chalk.yellow('  Select (1/2): ')) || '1';
                    const botAutoJoin = botMode === '2';

                    if (botAutoJoin) {
                        try {
                            const linksCheck = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean);
                            if (linksCheck.length === 0) {
                                console.log(chalk.red('\n❌ links.txt is empty!'));
                                readlineSync.question('Press Enter to continue...');
                                continue;
                            }
                            writeLinkPointer(0);
                            log.info(`📌 Link pointer reset. ${linksCheck.length} links loaded.`);
                        } catch (e) {
                            console.log(chalk.red('\n❌ links.txt not found!'));
                            readlineSync.question('Press Enter to continue...');
                            continue;
                        }
                    }

                    // Name style
                    console.log(chalk.cyan('\n  Name Style:'));
                    console.log(chalk.white('    1. Random'));
                    console.log(chalk.white('    2. Egyptian'));
                    const botNameChoice = readlineSync.question(chalk.yellow('  Select (1/2): ')) || '1';
                    NAME_STYLE = botNameChoice === '2' ? 'egyptian' : 'random';

                    console.log(chalk.cyan(`\n═══════════════════════════════════════`));
                    console.log(chalk.white(`  Starting Bot On Time: ${botEmails.length} accounts`));
                    console.log(chalk.cyan(`═══════════════════════════════════════\n`));

                    const botPassword = activeConfig.password || 'capcut321';
                    const NUM_BOT_WORKERS = Math.min(activeConfig.threads || 10, botEmails.length);
                    let botSuccess = 0, botFail = 0, botEmailIndex = 0;
                    let allLinksFull = false;
                    const workerPromises = [];

                    if (botAutoJoin) writeLinkPointer(0);

                    for (let w = 0; w < NUM_BOT_WORKERS; w++) {
                        workerPromises.push((async (workerId) => {
                            while (botEmailIndex < botEmails.length && !allLinksFull) {
                                const idx = botEmailIndex++;
                                if (idx >= botEmails.length) break;

                                const email = botEmails[idx];
                                const proxy = validProxies[idx % validProxies.length];

                                try {
                                    const result = await createAndJoinBotOnTime(workerId, email, botPassword, proxy, botAutoJoin);
                                    if (result.success) {
                                        botSuccess++;
                                        log.info(`📊 Progress: ${botSuccess}/${botEmails.length} succeeded | ${botFail} failed | Active: ${NUM_BOT_WORKERS}`);
                                    } else {
                                        botFail++;
                                    }
                                    if (result.allFull) {
                                        allLinksFull = true;
                                        log.warn(`\n⛔ ALL LINKS ARE FULL! Stopping new workers...`);
                                    }
                                } catch (err) {
                                    log.err(`Worker ${workerId} failed: ${err.message}`);
                                    botFail++;
                                }
                            }
                        })(w + 1));
                    }

                    await Promise.all(workerPromises);

                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('     BOT ON TIME COMPLETED'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    log.ok(`✅ Success: ${botSuccess}`);
                    if (botFail > 0) log.err(`❌ Failed: ${botFail}`);
                    log.info(`📊 Total: ${botEmails.length} emails`);
                    if (botSuccess > 0) console.log(chalk.gray(`📁 Results: results/botontime_created.txt`));
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));

                    readlineSync.question('Press Enter to continue...');
                    continue;
                }

                if (actionChoice !== '1' && actionChoice !== '2') {
                    console.log(chalk.red('❌ Invalid! Select 1, 2, 3, 4, 5, or 6.\n'));
                    readlineSync.question('Press Enter to continue...');
                    continue;
                }

                // Check links for Create + Join
                const autoJoin = actionChoice === '2';
                if (autoJoin) {
                    try {
                        const linksCheck = fs.readFileSync('links.txt', 'utf8').split(/\r?\n/).filter(Boolean);
                        if (linksCheck.length === 0) {
                            console.log(chalk.red('\n❌ links.txt is empty! Please add at least 1 link.'));
                            readlineSync.question('Press Enter to return...');
                            continue;
                        }
                        // Reset link pointer at start of new session
                        writeLinkPointer(0);
                        log.info(`📌 Link pointer reset. ${linksCheck.length} links loaded.`);
                    } catch (e) {
                        console.log(chalk.red('\n❌ links.txt not found!'));
                        readlineSync.question('Press Enter to return...');
                        continue;
                    }
                }

                // Start Workers with Queue System
                const MAX_CONCURRENT_WORKERS = 10;
                // Ask for name style
                console.log(chalk.cyan('\n  Name Style:'));
                console.log(chalk.white('    1. Random (abcdef1234)'));
                console.log(chalk.white('    2. Egyptian (ahmed123ab)'));
                const nameChoice = readlineSync.question(chalk.yellow('  Select (1/2): ')) || '1';
                NAME_STYLE = nameChoice === '2' ? 'egyptian' : 'random';
                console.log(chalk.gray(`  → Using ${NAME_STYLE} names\n`));

                const totalAccounts = parseInt(readlineSync.question(chalk.yellow('\n[?] Total accounts to create: '))) || 1;
                console.log(chalk.cyan('\n═══════════════════════════════════════'));
                console.log(chalk.white('        STARTING PROCESS...'));
                console.log(chalk.cyan(`        Max ${MAX_CONCURRENT_WORKERS} workers at a time`));
                console.log(chalk.cyan('═══════════════════════════════════════\n'));

                // Worker queue management
                let activeWorkers = 0;
                let completedWorkers = 0;
                let failedWorkers = 0;
                let queuedAccounts = totalAccounts;
                let processedAccounts = 0;
                let allLinksFull = false; // NEW: Stop if all links are full
                let allFullCount = 0;
                let retryQueue = []; // NEW: Track failed workers for retry
                let totalTarget = totalAccounts; // NEW: The target we want to reach
                const workerPromises = [];

                // Graceful shutdown handler
                let isShuttingDown = false;
                const handleShutdown = () => {
                    if (!isShuttingDown) {
                        isShuttingDown = true;
                        log.warn('\n🛑 Shutdown signal received. Waiting for active workers to finish...');
                    }
                };
                process.on('SIGINT', handleShutdown);
                process.on('SIGTERM', handleShutdown);

                // Function to spawn a worker
                let workerIdCounter = 0;
                const spawnWorker = (workerId) => {
                    if (isShuttingDown || allLinksFull) return null;

                    const proxyToUse = validProxies[workerId % validProxies.length];

                    return new Promise((resolve, reject) => {
                        const worker = new Worker(__filename, {
                            workerData: { threadId: workerId, config: activeConfig, proxy: proxyToUse, autoJoin, nameStyle: NAME_STYLE }
                        });

                        activeWorkers++;

                        worker.on('message', (res) => {
                            // NEW: Check if all links are full - need multiple confirmations
                            if (res.allFull) {
                                allFullCount = (allFullCount || 0) + 1;
                                if (allFullCount >= 3 || allFullCount >= Math.ceil(MAX_CONCURRENT_WORKERS / 2)) {
                                    allLinksFull = true;
                                    log.warn(`\n⛔ ALL LINKS ARE FULL! Stopping new workers...`);
                                } else {
                                    log.warn(`⚠️ Worker ${res.threadId} says links full (${allFullCount} reports so far, waiting for more confirmation...)`);
                                }
                            }

                            if (res.success && (res.joined || !autoJoin)) {
                                const joinStatus = autoJoin ? `(joined: ${res.joined})` : '(create only)';
                                const region = res.country ? `[${res.country}]` : '';
                                log.ok(`Worker ${res.threadId} ${region} done → ${res.email} ${joinStatus}`);
                                completedWorkers++;
                            } else if (res.success && autoJoin && !res.joined && !res.allFull) {
                                // Created but failed to join (not because links are full)
                                log.warn(`Worker ${res.threadId} created but join failed → will retry`);
                                failedWorkers++;
                            } else if (res.error) {
                                log.err(`Worker ${res.threadId} failed: ${res.error || 'Unknown error'}`);
                                failedWorkers++;
                            }

                            activeWorkers--;
                            processedAccounts++;

                            // Show progress
                            log.info(`📊 Progress: ${completedWorkers}/${totalTarget} succeeded | ${failedWorkers} failed | Active: ${activeWorkers}`);

                            resolve(res);

                            // Spawn next worker if there are more accounts to process
                            if (queuedAccounts > 0 && !isShuttingDown && !allLinksFull) {
                                queuedAccounts--;
                                workerIdCounter++;
                                const nextWorker = spawnWorker(workerIdCounter);
                                if (nextWorker) workerPromises.push(nextWorker);
                            }
                        });

                        worker.on('error', (err) => {
                            log.err(`Worker ${workerId} error: ${err.message || err}`);
                            activeWorkers--;
                            processedAccounts++;
                            failedWorkers++;
                            resolve({ success: false, error: err.message });

                            // Spawn next worker even on error
                            if (queuedAccounts > 0 && !isShuttingDown && !allLinksFull) {
                                queuedAccounts--;
                                workerIdCounter++;
                                const nextWorker = spawnWorker(workerIdCounter);
                                if (nextWorker) workerPromises.push(nextWorker);
                            }
                        });

                        worker.on('exit', (code) => {
                            if (code !== 0) {
                                log.warn(`Worker ${workerId} exited with code ${code}`);
                            }
                        });
                    });
                };

                // Start initial batch of workers (up to MAX_CONCURRENT_WORKERS)
                const initialBatch = Math.min(totalAccounts, MAX_CONCURRENT_WORKERS);
                for (let i = 1; i <= initialBatch; i++) {
                    queuedAccounts--;
                    workerIdCounter = i;
                    const workerPromise = spawnWorker(i);
                    if (workerPromise) workerPromises.push(workerPromise);
                }

                // Wait for all workers to complete (including dynamically spawned ones)
                const checkCompletion = () => {
                    return new Promise((resolve) => {
                        const interval = setInterval(() => {
                            if (processedAccounts >= totalAccounts) {
                                clearInterval(interval);
                                resolve();
                            }
                        }, 100); // Check every 100ms
                    });
                };

                try {
                    await checkCompletion();

                    // === AUTO-RETRY: If some failed and links aren't full, retry ===
                    const MAX_RETRY_ROUNDS = 2;
                    let retryRound = 0;

                    while (failedWorkers > 0 && !allLinksFull && !isShuttingDown && retryRound < MAX_RETRY_ROUNDS) {
                        retryRound++;
                        const retryCount = failedWorkers;
                        log.warn(`\n🔄 AUTO-RETRY Round ${retryRound}: Retrying ${retryCount} failed accounts...`);

                        // Reset counters for retry
                        const prevCompleted = completedWorkers;
                        failedWorkers = 0;
                        queuedAccounts = retryCount;
                        processedAccounts = 0;

                        const retryBatch = Math.min(retryCount, MAX_CONCURRENT_WORKERS);
                        for (let i = 0; i < retryBatch; i++) {
                            queuedAccounts--;
                            workerIdCounter++;
                            const wp = spawnWorker(workerIdCounter);
                            if (wp) workerPromises.push(wp);
                        }

                        // Wait for retry to finish
                        await new Promise((resolve) => {
                            const interval = setInterval(() => {
                                if (processedAccounts >= retryCount || allLinksFull) {
                                    clearInterval(interval);
                                    resolve();
                                }
                            }, 100);
                        });

                        log.info(`🔄 Retry Round ${retryRound} done: +${completedWorkers - prevCompleted} succeeded, ${failedWorkers} still failed`);
                    }

                    // Summary report
                    console.log(chalk.cyan('\n═══════════════════════════════════════'));
                    console.log(chalk.white('        PROCESS COMPLETED'));
                    console.log(chalk.cyan('═══════════════════════════════════════'));
                    log.ok(`✅ Completed: ${completedWorkers}/${totalTarget}`);
                    if (failedWorkers > 0) {
                        log.err(`❌ Failed: ${failedWorkers} (after ${MAX_RETRY_ROUNDS} retry rounds)`);
                    }
                    if (allLinksFull) {
                        log.warn(`⛔ All links are FULL - no more workspaces available`);
                    }
                    log.info(`📊 Target: ${totalTarget} accounts`);
                    console.log(chalk.cyan('═══════════════════════════════════════\n'));
                } catch (err) {
                    log.err(`Worker pool error: ${err.message}`);
                }

                // Clean up shutdown handlers
                process.removeListener('SIGINT', handleShutdown);
                process.removeListener('SIGTERM', handleShutdown);

                return;
            }
        }
    })();
} else {
    // Set name style from worker data
    if (workerData.nameStyle) NAME_STYLE = workerData.nameStyle;

    (async () => {
        try {
            let result;
            if (workerData.mode === 'joinOnly') {
                result = await joinOnly(
                    workerData.threadId,
                    workerData.accountData,
                    workerData.proxy,
                    workerData.regionMode || 'AUTO'  // NEW: Pass region mode
                );
            } else if (workerData.mode === 'changePassword') {
                result = await changePasswordWorker(
                    workerData.threadId,
                    workerData.accountData,
                    workerData.proxy
                );
            } else {
                result = await createAndJoin(
                    workerData.threadId,
                    workerData.config,
                    workerData.proxy,
                    workerData.autoJoin
                );
            }
            parentPort.postMessage({ ...result, threadId: workerData.threadId });
        } catch (error) {
            parentPort.postMessage({
                success: false,
                error: error.message || 'Unknown error',
                threadId: workerData.threadId
            });
        }
    })();
}