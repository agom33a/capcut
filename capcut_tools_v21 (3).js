const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const readlineSync = require('readline-sync');
const chalk = require('chalk');

const APP_ID = '348188';
const APPVR = '12.4.0';   // was 5.8.0 — commerce credit endpoint rejects old appvr with "login error"
const PF = '7';

function xorOperation(text, key = 5) {
    return [...text].map(c => String.fromCharCode(c.charCodeAt(0) ^ key)).join('');
}
function generateSign(url) {
    const deviceTime = Math.floor(Date.now() / 1000);
    const urlLast7 = url.slice(-7);
    const signString = `9e2c|${urlLast7}|${PF}|${APPVR}|${deviceTime}||11ac`;
    const sign = crypto.createHash('md5').update(signString).digest('hex');
    return { sign, deviceTime };
}
function generateDeviceId() { return crypto.randomBytes(9).readBigUInt64BE(0).toString(); }
function generateVerifyFp() {
    const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let fp = 'verify_';
    for (let i = 0; i < 16; i++) fp += c[Math.floor(Math.random() * c.length)];
    return fp;
}
function makeHeaders(cookie, url, extra = {}) {
    const { sign, deviceTime } = generateSign(url);
    const h = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
        'Origin': 'https://www.capcut.com', 'Referer': 'https://www.capcut.com/',
        'cookie': cookie, 'appId': APP_ID, 'appvr': APPVR, 'lan': 'en', 'pf': PF,
        'sign': sign, 'sign-ver': '1', 'device-time': deviceTime.toString(),
    };
    // Browser sends these on commerce endpoints; without them the credit
    // endpoint returns ret 34010105 "login error" with zeroed data.
    if (extra.deviceId) { h['did'] = extra.deviceId; h['web_id'] = extra.deviceId; h['tdid'] = ''; }
    if (extra.region)   { h['loc'] = extra.region.toUpperCase(); h['store-country-code'] = extra.region.toLowerCase(); h['store-country-code-src'] = 'uid'; }
    return h;
}
function formatDate(ts) {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toISOString().split('T')[0];
}
function formatStorage(bytes) {
    if (!bytes || bytes <= 1) return 'None';
    if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(0) + ' TB';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(0) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
    return bytes + ' B';
}

// CapCut returns some labels in Arabic/Chinese which render broken (RTL) in a
// terminal. Map the known ones to clean English; strip RTL marks from the rest.
// Returns { text, translated } so the caller can flag translated labels.
function cleanLabel(s) {
    if (!s) return { text: 'unknown', translated: false };
    let t = s.toString().replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    const map = [
        [/Teams.*عضو المساحة|عضو المساحة/, 'Teams (space member)'],
        [/معمل الذكاء الاصطناعي/, 'AI Lab'],
        [/智能编辑/, 'Smart edit'],
        [/تعذّر الإنشاء.*/, 'Generation failed - refunded'],
    ];
    for (const [re, en] of map) if (re.test(t)) return { text: en, translated: true };
    // Non-ASCII left over (unknown label): strip it and flag as translated.
    if (/[^\x00-\x7F]/.test(t)) {
        const stripped = t.replace(/[^\x00-\x7F]+/g, '').trim();
        return { text: stripped || 'non-English label', translated: true };
    }
    return { text: t, translated: false };
}

// Render a label with a "← translated from original" marker when applicable.
function labelWithTag(raw) {
    const { text, translated } = cleanLabel(raw);
    return translated ? `${text} ${chalk.dim('← translated from CapCut original')}` : text;
}

async function loginCapcut(email, password, domains, deviceId, agent) {
    const ee = Buffer.from(xorOperation(email)).toString('hex');
    const ep = Buffer.from(xorOperation(password)).toString('hex');
    for (let a = 0; a < 10; a++) {
        try {
            const opts = {
                params: { aid:APP_ID, language:'en', check_region:'1', account_sdk_source:'web', sdk_version:'2.1.10-tiktok', verifyFp: generateVerifyFp() },
                headers: {
                    'content-type':'application/x-www-form-urlencoded',
                    'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                    'Origin':'https://www.capcut.com','Referer':'https://www.capcut.com/',
                    'appid':APP_ID,'did':deviceId,'store-country-code':domains.regionParams,'store-country-code-src':'uid'
                },
                timeout: 20000
            };
            if (agent) opts.httpsAgent = agent;
            const res = await axios.post(
                `${domains.login}/passport/web/email/login/`,
                new URLSearchParams({ mix_mode:'1', email:ee, password:ep, fixed_mix_mode:'1' }),
                opts
            );
            console.log(`  [Login attempt ${a+1}] message=${res.data?.message}, desc=${res.data?.data?.description || 'none'}, cookies=${res.headers['set-cookie']?.length || 0}`);
            if (res.data?.message === 'success') {
                const sc = res.headers['set-cookie'];
                if (sc?.length > 0) return { session: sc.map(c => c.split(';')[0]).join('; '), userData: res.data.data };
                // Login succeeded but no cookies
                throw new Error('Login OK but no cookies returned');
            }
            const ed = res.data?.data?.description || res.data?.message || '';
            if (ed.includes('Maximum') || ed.includes('attempts')) { throw new Error(ed); }
            if (ed.includes('rate')) { await new Promise(r => setTimeout(r, 2000)); continue; }
            throw new Error(ed || `Login failed (message: ${res.data?.message})`);
        } catch (err) { if (a === 9) throw err; if (!err.message.includes('rate')) throw err; }
    }
    return null;
}

async function apiPost(url, body, cookie, agent, extra = {}) {
    const res = await axios.post(url, body, { headers: makeHeaders(cookie, url, extra), httpsAgent: agent, timeout: 15000 });
    return res.data;
}

// ═══════════════════════════════════
//  TOOL 1: REMOVE MEMBERS
// ═══════════════════════════════════
async function toolRemoveMembers(session, ws, domains, agent) {
    while (true) {
        console.log(chalk.cyan(`\n👥 Members of "${ws.name}":`));
        let members = [];
        try {
            const res = await apiPost(`${domains.api}/cc/v1/workspace/get_member`,
                { count: 50, cursor: '0', workspace_id: ws.workspace_id }, session, agent);
            members = res.data?.member_list || [];
            console.log('');
            members.forEach((m, i) => {
                const roleColor = m.role === 'owner' ? chalk.yellow : chalk.white;
                console.log(roleColor(`  ${i + 1}. ${m.nickname} (${m.role}) [UID: ${m.uid}]`));
            });
            console.log(chalk.gray(`\n  Total: ${members.length}/${ws.member_limit}`));
        } catch (err) { console.log(chalk.red(`❌ Failed: ${err.message}`)); break; }

        const input = readlineSync.question(chalk.yellow('\nRemove (e.g. 2,3,4 | "all" | "back"): '));
        if (input.toLowerCase() === 'back') break;

        let toRemove = [];
        if (input.toLowerCase() === 'all') {
            toRemove = members.filter(m => m.role !== 'owner');
        } else {
            const indices = input.split(',').map(s => parseInt(s.trim()) - 1).filter(i => !isNaN(i) && i >= 0 && i < members.length);
            toRemove = indices.map(i => members[i]).filter(m => m.role !== 'owner');
        }
        if (toRemove.length === 0) { console.log(chalk.red('❌ No valid members')); continue; }

        console.log(chalk.cyan(`\n🗑️ Removing ${toRemove.length} member(s)...\n`));
        let ok = 0, fail = 0;
        for (const t of toRemove) {
            try {
                const res = await apiPost(`${domains.api}/cc/v1/workspace/remove_user`,
                    { workspace_id: ws.workspace_id, uid: t.uid }, session, agent);
                if (res.ret === '0') { console.log(chalk.green(`  ✅ ${t.nickname} → Removed`)); ok++; }
                else { console.log(chalk.red(`  ❌ ${t.nickname} → ${res.errmsg}`)); fail++; }
            } catch (err) {
                console.log(chalk.red(`  ❌ ${t.nickname} → ${err.response?.data?.errmsg || err.message}`)); fail++;
            }
            await new Promise(r => setTimeout(r, 300));
        }
        console.log(chalk.cyan(`\n📊 ${ok} removed, ${fail} failed`));
    }
}

// ═══════════════════════════════════
//  TOOL 2: RENAME WORKSPACE
// ═══════════════════════════════════
async function toolRenameWorkspace(session, ws, domains, agent) {
    console.log(chalk.cyan(`\n📝 Current name: "${ws.name}"`));
    const newName = readlineSync.question(chalk.yellow('New name: '));
    if (!newName.trim()) { console.log(chalk.red('❌ Empty name')); return; }
    try {
        const res = await apiPost(`${domains.api}/cc/v1/workspace/update_workspace_info`,
            { workspace_id: ws.workspace_id, name: newName.trim() }, session, agent);
        if (res.ret === '0') { console.log(chalk.green(`✅ Renamed to "${newName.trim()}"!`)); ws.name = newName.trim(); }
        else { console.log(chalk.red(`❌ Failed: ${res.errmsg}`)); }
    } catch (err) { console.log(chalk.red(`❌ Failed: ${err.response?.data?.errmsg || err.message}`)); }
}

// ═══════════════════════════════════
//  TOOL 3: INVITE BY EMAIL (API)
// ═══════════════════════════════════
async function toolInviteByEmail(session, ws, domains, agent) {
    const emailInput = readlineSync.question(chalk.yellow('Email(s) to invite (comma separated): '));
    const emails = emailInput.split(',').map(e => e.trim()).filter(e => e.includes('@'));
    if (emails.length === 0) { console.log(chalk.red('❌ No valid emails')); return; }
    const emailObjects = emails.map(e => ({ email: e, role: 3 }));
    console.log(chalk.cyan(`\n📧 Inviting ${emails.length} email(s)...\n`));
    try {
        const res = await apiPost(`${domains.api}/cc/v1/workspace/email_directional_invited_v2`,
            { workspace_id: ws.workspace_id, emails: emailObjects, query_param: {} }, session, agent);
        if (res.ret === '0') {
            for (const e of emails) console.log(chalk.green(`  ✅ ${e} → Invited`));
            console.log(chalk.cyan(`\n📊 ${emails.length} invitation(s) sent!`));
        } else { console.log(chalk.red(`❌ Failed: ${res.errmsg}`)); }
    } catch (err) { console.log(chalk.red(`❌ Failed: ${err.response?.data?.errmsg || err.message}`)); }
}

// ═══════════════════════════════════
//  TOOL 4: VIEW MEMBERS
// ═══════════════════════════════════
async function toolViewMembers(session, ws, domains, agent) {
    try {
        const res = await apiPost(`${domains.api}/cc/v1/workspace/get_member`,
            { count: 50, cursor: '0', workspace_id: ws.workspace_id }, session, agent);
        const members = res.data?.member_list || [];
        console.log(chalk.green(`\n✅ ${members.length} members:\n`));
        members.forEach((m, i) => {
            const c = m.role === 'owner' ? chalk.yellow : chalk.white;
            console.log(c(`  ${i + 1}. ${m.nickname} (${m.role}) [UID: ${m.uid}]`));
        });
    } catch (err) { console.log(chalk.red(`❌ ${err.message}`)); }
}

// ═══════════════════════════════════
//  TOOL 5: GET INVITE LINK
// ═══════════════════════════════════
async function toolGetInviteLink(session, ws, domains, agent) {
    try {
        const res = await apiPost(`${domains.api}/cc/v1/workspace/get_invitation_link`,
            { workspace_id: ws.workspace_id }, session, agent);
        if (res.ret === '0' && res.data?.invitation_link) {
            console.log(chalk.green(`\n🔗 Invite Link: ${res.data.invitation_link}`));
            console.log(chalk.gray(`   Expires: ${formatDate(res.data.expire_time)}`));
            console.log(chalk.gray(`   Status: ${res.data.invite_status === 1 ? 'Active' : 'Inactive'}`));
        } else { console.log(chalk.red(`❌ Failed: ${res.errmsg}`)); }
    } catch (err) { console.log(chalk.red(`❌ ${err.response?.data?.errmsg || err.message}`)); }
}

// ═══════════════════════════════════
//  TOOL 6: FULL ACCOUNT INFO
// ═══════════════════════════════════
async function toolAccountInfo(session, ws, domains, agent, userData, allWorkspaces, deviceId) {
    const commerce = domains.api.replace('edit-api-sg', 'commerce-api-sg');
    const acctRegion = (allWorkspaces[0]?.region || domains.regionParams || 'EG');
    const credExtra = { deviceId, region: acctRegion };

    console.log(chalk.cyan('\n═══════════════════════════════════════'));
    console.log(chalk.white('       📋 FULL ACCOUNT INFORMATION'));
    console.log(chalk.cyan('═══════════════════════════════════════'));

    // === Account Info (from login response) ===
    console.log(chalk.cyan('\n  👤 Account:'));
    console.log(chalk.white(`     User ID:        ${userData.user_id_str || userData.user_id}`));
    console.log(chalk.white(`     Username:       ${userData.name || userData.screen_name}`));
    console.log(chalk.white(`     Screen Name:    ${userData.screen_name || 'N/A'}`));
    console.log(chalk.white(`     Email:          ${userData.email || 'N/A'}`));
    console.log(chalk.white(`     Created:        ${formatDate(userData.user_create_time)}`));
    console.log(chalk.white(`     Blocked:        ${userData.is_blocked ? '❌ YES' : '✅ No'}`));
    console.log(chalk.white(`     Has Password:   ${userData.has_password ? 'Yes' : 'No'}`));
    console.log(chalk.white(`     Has Phone:      ${userData.phone_collected ? 'Yes' : 'No'}`));
    console.log(chalk.white(`     Gender:         ${userData.gender === 1 ? 'Male' : userData.gender === 2 ? 'Female' : 'Not set'}`));
    console.log(chalk.white(`     Birthday:       ${userData.birthday || 'Not set'}`));
    console.log(chalk.white(`     Avatar:         ${userData.avatar_url || 'N/A'}`));
    console.log(chalk.white(`     Verified:       ${userData.user_verified ? 'Yes' : 'No'}`));
    console.log(chalk.white(`     New User:       ${userData.new_user ? 'Yes' : 'No'}`));
    console.log(chalk.white(`     Sec User ID:    ${userData.sec_user_id || 'N/A'}`));

    // === Personal VIP Subscription ===
    console.log(chalk.cyan('\n  💳 Personal Subscription (Pro/VIP):'));
    let wsSubInfo = null;
    try {
        const subRes = await apiPost(`${commerce}/commerce/v1/subscription/user_info`,
            { aid: '348188', scene: 'vip' }, session, agent);
        const sub = JSON.parse(subRes.response || '{}');
        
        if (sub.flag) {
            console.log(chalk.green(`     Status:         ✅ VIP Active`));
            console.log(chalk.white(`     Plan:           ${sub.product_id}`));
            console.log(chalk.white(`     Type:           ${sub.subscribe_type === 'auto' ? 'Auto-renew' : 'Manual'}`));
            console.log(chalk.white(`     Cycle:          ${sub.subscribe_cycle} ${sub.cycle_unit}`));
            console.log(chalk.white(`     Start:          ${formatDate(sub.start_time)}`));
            console.log(chalk.white(`     End:            ${formatDate(sub.end_time)}`));
            console.log(chalk.white(`     Renewal:        ${formatDate(sub.renewal_time)}`));
            console.log(chalk.white(`     VIP Level:      ${sub.cur_vip_level || 'N/A'}`));
            console.log(chalk.white(`     Free Trial:     ${sub.is_free_trial ? 'Yes' : 'No'}`));
            console.log(chalk.white(`     Cancel:         ${sub.is_cancel_subscribe ? 'Cancelled' : 'Active'}`));
        } else {
            console.log(chalk.gray(`     Status:         ❌ No personal subscription`));
            console.log(chalk.gray(`     Can Free Trial: ${sub.can_free_trial ? 'Yes (' + sub.can_free_trial_days + ' days)' : 'No'}`));
            console.log(chalk.gray(`     First Sub:      ${sub.is_first_subscribe ? 'Yes (never subscribed)' : 'No (was subscribed before)'}`));
        }

        // Team/Workspace subscription from user_info
        wsSubInfo = sub.workspace_subscribe_info;
        if (wsSubInfo && wsSubInfo.flag) {
            console.log(chalk.cyan('\n  🏢 Team Subscription (from user_info):'));
            console.log(chalk.green(`     Status:         ✅ Team Active`));
            console.log(chalk.white(`     VIP End:        ${formatDate(wsSubInfo.vip_real_end)}`));
            if (wsSubInfo.ongoing_plans && wsSubInfo.ongoing_plans.length > 0) {
                for (const plan of wsSubInfo.ongoing_plans) {
                    console.log(chalk.white(`     Workspace ID:   ${plan.workspace_id}`));
                    console.log(chalk.white(`     Start:          ${formatDate(plan.vip_start)}`));
                    console.log(chalk.white(`     End:            ${formatDate(plan.vip_end)}`));
                    console.log(chalk.white(`     Max Members:    ${plan.subscribe_member_max_cnt}`));
                    console.log(chalk.white(`     Renewal:        ${formatDate(plan.renewal_time)}`));
                    console.log(chalk.white(`     Type:           ${plan.subscribe_type === 'auto' ? 'Auto-renew' : 'Manual (no auto-renew)'}`));
                    console.log(chalk.white(`     Cycle:          ${plan.subscribe_cycle} ${plan.cycle_unit}`));
                }
            }
        }
    } catch (err) { console.log(chalk.red(`     ❌ Failed to get subscription info`)); }

    // === VIP/Pro Payment Details ===
    console.log(chalk.cyan('\n  💰 Payment Details (Pro):'));
    try {
        const payRes = await apiPost(`${commerce}/commerce/v3/trade/subscription_infos`,
            { scene: ['vip', 'workspace'], vip_levels: ['vip', 'svip'], app_id: 348188 }, session, agent);
        const payData = JSON.parse(payRes.response || '{}');
        const vipSubs = payData.subscription_user_infos?.vip?.subscription_infos || [];
        const wsSubs = payData.subscription_user_infos?.workspace?.subscription_infos || [];

        if (vipSubs.length > 0) {
            console.log(chalk.cyan('     --- VIP/Pro ---'));
            for (const s of vipSubs) {
                const sku = s.sku_info || {};
                const billing = sku.billing_amount || {};
                const intro = sku.intro_amount || {};
                const cycle = sku.sku_cycle || {};
                console.log(chalk.white(`     Plan Name:      ${sku.sku_name || 'N/A'}`));
                console.log(chalk.white(`     SKU ID:         ${sku.sku_id || 'N/A'}`));
                console.log(chalk.white(`     Product ID:     ${sku.product_id || 'N/A'}`));
                console.log(chalk.white(`     Price:          ${billing.amount_tips || 'N/A'} (${billing.currency_code || ''})`));
                if (intro.amount && intro.amount !== billing.amount) {
                    console.log(chalk.white(`     Intro Price:    ${intro.amount_tips || 'N/A'} (${intro.currency_code || ''})`));
                }
                const nextRenew = s.next_renew_amount || {};
                console.log(chalk.white(`     Next Renew:     ${nextRenew.amount_tips || 'N/A'} (${nextRenew.currency_code || ''})`));
                console.log(chalk.white(`     Payment Method: ${s.payment_method || 'N/A'}`));
                console.log(chalk.white(`     Can Cancel:     ${s.can_cancel ? 'Yes' : 'No'}`));
                console.log(chalk.white(`     Status:         ${s.status || 'N/A'}`));
                console.log(chalk.white(`     Start:          ${formatDate(s.start_time)}`));
                console.log(chalk.white(`     End:            ${formatDate(s.end_time)}`));
                console.log(chalk.white(`     Next Renew At:  ${formatDate(s.next_renew_time)}`));
                console.log(chalk.white(`     Sub ID:         ${s.subscription_id || 'N/A'}`));
                console.log(chalk.white(`     Platform:       ${s.platform === 0 ? 'Web' : s.platform === 1 ? 'iOS' : s.platform === 2 ? 'Android' : s.platform || 'N/A'}`));
                const benefit = sku.sku_benefit || {};
                console.log(chalk.white(`     VIP Level:      ${benefit.level || 'N/A'}`));
            }
        }

        if (wsSubs.length > 0) {
            console.log(chalk.cyan('     --- Team/Workspace Payment ---'));
            for (const s of wsSubs) {
                const sku = s.sku_info || {};
                const billing = sku.billing_amount || {};
                const intro = sku.intro_amount || {};
                console.log(chalk.white(`     Plan Name:      ${sku.sku_name || 'N/A'}`));
                console.log(chalk.white(`     Price:          ${billing.amount_tips || 'N/A'} (${billing.currency_code || ''})`));
                if (intro.amount && intro.amount !== billing.amount) {
                    console.log(chalk.white(`     Intro Price:    ${intro.amount_tips || 'N/A'} (${intro.currency_code || ''})`));
                }
                const nextRenew = s.next_renew_amount || {};
                console.log(chalk.white(`     Next Renew:     ${nextRenew.amount_tips || 'N/A'} (${nextRenew.currency_code || ''})`));
                console.log(chalk.white(`     Payment Method: ${s.payment_method || 'N/A'}`));
                console.log(chalk.white(`     Can Cancel:     ${s.can_cancel ? 'Yes' : 'No'}`));
                console.log(chalk.white(`     Sub ID:         ${s.subscription_id || 'N/A'}`));
            }
        }

        if (vipSubs.length === 0 && wsSubs.length === 0) {
            console.log(chalk.gray(`     No payment details available (subscription may be via code/gift)`));
        }
    } catch (err) { console.log(chalk.gray(`     No payment info available`)); }

    // === Available Prices ===
    console.log(chalk.cyan('\n  🏷️ Available Prices:'));
    try {
        const region = allWorkspaces[0]?.region || 'EG';
        // VIP prices
        const vipPriceRes = await apiPost(`${commerce}/commerce/v1/subscription/cc_web_price_list`,
            { aid: 348188, scene: 'vip', region }, session, agent);
        const vipPrices = JSON.parse(vipPriceRes.response || '{}').all_price_list || [];
        if (vipPrices.length > 0) {
            console.log(chalk.gray('     --- Pro Plans ---'));
            for (const p of vipPrices.slice(0, 4)) {
                const name = p.package_name || p.product_tips || p.product_id;
                console.log(chalk.gray(`     ${name}: ${p.currency_tips || '$'}${p.price_tips}/${p.cycle_tips || p.cycle_unit || 'month'} ${p.origin_price_tips ? '(was ' + p.origin_price_tips + ')' : ''}`));
            }
        }
        // Workspace prices
        const wsPriceRes = await apiPost(`${commerce}/commerce/v1/subscription/cc_web_price_list`,
            { aid: 348188, scene: 'workspace', region }, session, agent);
        const wsPrices = JSON.parse(wsPriceRes.response || '{}').all_price_list || [];
        if (wsPrices.length > 0) {
            console.log(chalk.gray('     --- Workspace Plans ---'));
            for (const p of wsPrices.slice(0, 4)) {
                const name = p.product_capacity_tips || p.product_id;
                console.log(chalk.gray(`     ${name}: ${p.currency_tips || '$'}${p.price_tips}/${p.subscribe_cycle || 1}mo`));
            }
        }
    } catch (e) {}

    // === All Workspaces with full details ===
    console.log(chalk.cyan('\n  🏢 Workspaces:'));
    for (const w of allWorkspaces) {
        const available = w.member_limit - w.member_cnt;
        console.log(chalk.white(`\n     📌 ${w.name}`));
        console.log(chalk.gray(`        ID:              ${w.workspace_id}`));
        console.log(chalk.gray(`        Space ID:        ${w.space_id || 'N/A'}`));
        console.log(chalk.gray(`        Role:            ${w.role}`));
        console.log(chalk.gray(`        Members:         ${w.member_cnt}/${w.member_limit} (${available} available)`));
        console.log(chalk.gray(`        Region:          ${w.region || 'N/A'}`));
        console.log(chalk.gray(`        IDC:             ${w.idc || 'N/A'}`));
        console.log(chalk.gray(`        Space IDC:       ${w.space_idc || 'N/A'}`));
        console.log(chalk.gray(`        Storage:         ${formatStorage(w.quota)} (Used: ${formatStorage(w.usage)})`));
        console.log(chalk.gray(`        Owner:           ${w.owner_name} (ID: ${w.owner})`));
        console.log(chalk.gray(`        Avatar Color:    ${w.avatar_color || 'N/A'}`));
        console.log(chalk.gray(`        Space Type:      ${w.space_type || 'N/A'} (Raw: ${w.raw_space_type || 'N/A'})`));
        console.log(chalk.gray(`        Status:          ${w.status === 1 ? 'Active' : w.status || 'N/A'}`));
        console.log(chalk.gray(`        Team VIP Status: ${w.team_vip_status === 1 ? '✅ Active' : w.team_vip_status || 'N/A'}`));
        if (w.team_vip_end) console.log(chalk.gray(`        Team VIP End:    ${formatDate(w.team_vip_end)}`));
        console.log(chalk.gray(`        Auto Subscribe:  ${w.is_auto_subscribe ? 'Yes' : 'No'}`));
        if (w.next_auto_subscribe_time) console.log(chalk.gray(`        Next Auto Sub:   ${formatDate(w.next_auto_subscribe_time)}`));
        console.log(chalk.gray(`        Max Sub Members: ${w.subscribe_member_max_cnt || 'N/A'}`));
        console.log(chalk.gray(`        Invite Allowed:  ${w.invite_permission === 1 ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`        Approval Req:    ${w.approval_required ? 'Yes' : 'No'}`));

        // Get workspace subscription details
        try {
            const wsSubRes = await apiPost(`${commerce}/commerce/v1/subscription/workspace/space_list`,
                { aid: 348188, workspace_id: w.workspace_id }, session, agent);
            const wsSubData = JSON.parse(wsSubRes.response || '{}');
            if (wsSubData.space_list && wsSubData.space_list.length > 0) {
                const sp = wsSubData.space_list[0];
                console.log(chalk.gray(`        Plan:            ${sp.product_id}`));
                console.log(chalk.gray(`        Plan Status:     ${sp.status === 3 ? 'Active' : sp.status}`));
                console.log(chalk.gray(`        Capacity:        ${formatStorage(sp.space_capacity)}`));
                console.log(chalk.gray(`        Expires:         ${formatDate(sp.space_end)}`));
                console.log(chalk.gray(`        Time Left:       ${Math.round((sp.space_time || 0) / 86400)} days`));
                console.log(chalk.gray(`        Permanent:       ${sp.is_permanent ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        Freezing:        ${sp.is_freezing ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        From Gift:       ${sp.is_from_give ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        Auto Subscribe:  ${wsSubData.is_auto_subscribe ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        Web Auto Sub:    ${wsSubData.is_web_auto_subscribe ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        First Sub:       ${wsSubData.is_first_subscribe ? 'Yes' : 'No'}`));
                console.log(chalk.gray(`        Cancelled:       ${wsSubData.is_cancel_subscribe ? 'Yes' : 'No'}`));
            } else {
                console.log(chalk.gray(`        Plan:            Free`));
            }
        } catch (e) {}

        // Get invite link (owner only)
        if (w.role === 'owner') {
            try {
                const linkRes = await apiPost(`${domains.api}/cc/v1/workspace/get_invitation_link`,
                    { workspace_id: w.workspace_id }, session, agent);
                if (linkRes.ret === '0' && linkRes.data?.invitation_link) {
                    console.log(chalk.gray(`        Invite Link:     ${linkRes.data.invitation_link}`));
                    console.log(chalk.gray(`        Link Expires:    ${formatDate(linkRes.data.expire_time)}`));
                    console.log(chalk.gray(`        Link Status:     ${linkRes.data.invite_status === 1 ? 'Active' : 'Inactive'}`));
                }
            } catch (e) {}
        }

        // Get members summary
        try {
            const memRes = await apiPost(`${domains.api}/cc/v1/workspace/get_member`,
                { count: 50, cursor: '0', workspace_id: w.workspace_id }, session, agent);
            const members = memRes.data?.member_list || [];
            const owners = members.filter(m => m.role === 'owner').length;
            const collabs = members.filter(m => m.role === 'collaborator').length;
            console.log(chalk.gray(`        Members:         ${owners} owner(s), ${collabs} collaborator(s)`));
        } catch (e) {}
    }

    // === Create Workspace Limits ===
    console.log(chalk.cyan('\n  📊 Workspace Limits:'));
    try {
        const checkRes = await apiPost(`${domains.api}/cc/v1/workspace/check_create_workspace`, {}, session, agent);
        if (checkRes.ret === '0') {
            console.log(chalk.gray(`     Has Workspace:      ${checkRes.data.has_create ? 'Yes' : 'No'}`));
            console.log(chalk.gray(`     Has Commerce WS:    ${checkRes.data.has_commerce_create ? 'Yes' : 'No'}`));
            console.log(chalk.gray(`     Max Free:           ${checkRes.data.max_create_limit}`));
            console.log(chalk.gray(`     Max Paid:           ${checkRes.data.max_commerce_create_limit}`));
            console.log(chalk.gray(`     Can Create More:    ${checkRes.data.can_create_space ? 'Yes' : 'No'}`));
            console.log(chalk.gray(`     Create Type:        ${checkRes.data.create_type || 'N/A'}`));
        }
    } catch (e) {}

    // === AI Credits (FIXED: real residual balance) ===
    console.log(chalk.cyan('\n  🤖 AI Credits:'));
    try {
        const creditUrl = `${commerce}/commerce/v1/benefits/user_credit`;
        const creditRes = await apiPost(creditUrl, {}, session, agent, credExtra);
        const creditData = JSON.parse(creditRes.response || '{}');
        const credit = creditData.credit || {};
        const detail = creditData.credits_detail || {};

        // residual_credits = the REAL remaining balance (what CapCut shows)
        const vipList = detail.vip_credits || detail.credits || [];
        let residualTotal = 0;
        for (const c of vipList) residualTotal += (c.residual_credits || 0);

        if (String(creditRes.ret) !== '0') {
            console.log(chalk.yellow(`     ⚠️ ${creditRes.errmsg || 'error'} (ret ${creditRes.ret}) — data may be incomplete`));
        }
        console.log(chalk.green(`     Available Now:      ${residualTotal}   ← real balance (what CapCut shows)`));

        if (vipList.length > 0) {
            console.log(chalk.cyan('     By source:'));
            for (const c of vipList) {
                const src = labelWithTag(c.remark || c.vip_level);
                const endStr = c.credits_life_end ? formatDate(c.credits_life_end) : 'N/A';
                console.log(chalk.gray(`     ✦ ${c.residual_credits ?? 0} — ${src} (expires ${endStr})`));
            }
        }
        console.log(chalk.gray(`     ── raw allocated (reference) ──`));
        console.log(chalk.gray(`     ├─ vip_credit:      ${credit.vip_credit ?? 0}`));
        console.log(chalk.gray(`     ├─ gift_credit:     ${credit.gift_credit ?? 0}`));
        console.log(chalk.gray(`     └─ purchase_credit: ${credit.purchase_credit ?? 0}`));
    } catch (e) { console.log(chalk.gray(`     Credits:            N/A (${e.message})`)); }

    // === Credit History (total granted / consumed) — paginated ===
    console.log(chalk.cyan('\n  📜 Credit History:'));
    try {
        const histUrl = `${commerce}/commerce/v1/benefits/user_credit_history`;

        // Pull ALL pages for a history_type (grants=1, consumption=2).
        // Only status "Checked"/"Checking" count; "CheckFailed" was refunded.
        async function fetchAllHistory(historyType) {
            let cursor = '0', all = [], guard = 0;
            while (guard++ < 30) {
                const res = await apiPost(histUrl,
                    { cursor, count: 50, history_type: historyType, need_with_hold: true },
                    session, agent, credExtra);
                const data = JSON.parse(res.response || '{}');
                const recs = data.records || [];
                all = all.concat(recs);
                if (!data.has_more || !data.new_cursor) break;
                cursor = data.new_cursor;
            }
            return all;
        }

        const addRecords = await fetchAllHistory(1);
        const useRecords = await fetchAllHistory(2);

        const failed = r => String(r.status || '').toLowerCase() === 'checkfailed';
        let totalGranted = 0;
        for (const r of addRecords) if (!failed(r)) totalGranted += (r.amount || 0);
        let totalConsumed = 0;
        for (const r of useRecords) if (!failed(r)) totalConsumed += (r.amount || 0);

        console.log(chalk.white(`     Total Granted:      ${totalGranted}   ← original total ("out of")`));
        console.log(chalk.white(`     Total Consumed:     ${totalConsumed}`));
        console.log(chalk.white(`     Remaining (calc):   ${totalGranted - totalConsumed}`));

        if (addRecords.length > 0) {
            console.log(chalk.cyan('     Grants:'));
            for (const r of addRecords.slice(0, 10)) {
                const src = labelWithTag(r.title || r.trade_source);
                const flag = failed(r) ? ' (refunded)' : '';
                console.log(chalk.gray(`     + ${r.amount} — ${src} (${formatDate(r.create_time)}, exp ${formatDate(r.life_end)})${flag}`));
            }
        }
        if (useRecords.length > 0) {
            console.log(chalk.cyan(`     Consumption (last 10 of ${useRecords.length}):`));
            for (const r of useRecords.slice(0, 10)) {
                const src = labelWithTag(r.title || r.trade_source);
                const flag = failed(r) ? ' (refunded)' : '';
                console.log(chalk.gray(`     - ${r.amount} — ${src} (${formatDate(r.create_time)})${flag}`));
            }
        }
        if (addRecords.length === 0 && useRecords.length === 0) {
            console.log(chalk.gray(`     No history records`));
        }
    } catch (e) { console.log(chalk.gray(`     History: N/A (${e.message})`)); }

    // === Credit Info (Pop-up) — reference amounts per plan, NOT actual balance ===
    try {
        const popUrl = `${commerce}/commerce/v1/subscription/pop_up`;
        const popRes = await apiPost(popUrl, { aid: 348188 }, session, agent);
        const popData = JSON.parse(popRes.response || '{}');
        const c = popData.credit || {};
        if (c.enable !== undefined) {
            console.log(chalk.cyan('\n  ℹ️  Plan Credit Reference (if subscribed in this region):'));
            console.log(chalk.gray(`     (These are DEFAULT amounts per plan — NOT this account's balance)`));
            console.log(chalk.gray(`     Standard/Pro:       ${c.standard_amount ?? 0}`));
            console.log(chalk.gray(`     VIP:                ${c.vip_amount ?? 0}`));
            console.log(chalk.gray(`     Teams:              ${c.teams_amount ?? 0}`));
            console.log(chalk.gray(`     Ultra:              ${c.ultra_amount ?? 0}`));
            console.log(chalk.gray(`     Gift:               ${c.gift_amount ?? 0}`));
        }
    } catch (e) {}


    // === Plans - AI Credits Preview (v3) ===
    console.log(chalk.cyan('\n  🎯 If You Subscribed, You\'d Get (AI Credits/month):'));
    try {
        const region = (allWorkspaces[0]?.region || 'EG').toUpperCase();
        const ownerWs = allWorkspaces.find(w => w.role === 'owner');
        const wsIdForTeams = ownerWs?.workspace_id || '';

        const batchReqParams = [
            { path: '/commerce/v1/subscription/cc_price_list', key: 'vip',
              body: { aid: 348188, region, scene: 'vip' } },
            { path: '/commerce/v1/subscription/cc_price_list', key: 'ultra',
              body: { aid: 348188, region, scene: 'ultra' } }
        ];
        if (wsIdForTeams) {
            batchReqParams.push({
                path: '/commerce/v1/subscription/cc_price_list',
                key: 'teams',
                body: { aid: 348188, region, scene: 'teams', workspace_id: wsIdForTeams }
            });
        }

        const batchRes = await apiPost(`${commerce}/commerce/v1/subscription/batch_get`,
            { data_optimize: true, request_param_list: batchReqParams }, session, agent);
        const sections = JSON.parse(batchRes.response || '[]');

        for (const section of sections) {
            const catName = section.key || 'unknown';
            const resp = section.response || {};
            const prices = resp.data?.all_price_list || [];
            if (prices.length === 0) continue;

            // Nice category header
            const catLabel = catName === 'vip'   ? '💎 Pro (VIP)'
                           : catName === 'ultra' ? '🌟 Ultra'
                           : catName === 'teams' ? '👥 Teams'
                           : catName;
            console.log(chalk.gray(`     --- ${catLabel} ---`));

            for (const p of prices) {
                const price = `${p.currency_tips || '$'}${p.price_tips}`;
                const cycle = p.cycle_unit === 'MONTH' && p.subscribe_cycle === 12 ? '/year'
                            : p.cycle_unit === 'MONTH' ? '/month'
                            : `/${p.subscribe_cycle}${p.cycle_unit?.toLowerCase() || 'mo'}`;
                const creditsAmt = p.vip_benefit_package?.user_credit?.amount;
                const creditsStr = creditsAmt !== undefined && creditsAmt !== null
                    ? `💎 ${creditsAmt} credits`
                    : `(no monthly credits)`;
                const seatsMatch = (p.product_id || '').match(/(\d+)seats/);
                const seatsStr = seatsMatch ? ` (per seat × ${seatsMatch[1]})` : '';
                const nameField = (p.product_id || '').padEnd(38);
                console.log(chalk.white(`     ${nameField} ${(price + cycle).padEnd(18)} ${creditsStr}${seatsStr}`));
            }
        }
    } catch (e) { console.log(chalk.gray(`     N/A (${e.message})`)); }

    // === Credit Purchase Prices ===
    console.log(chalk.cyan('\n  💎 Credit Purchase Prices:'));
    try {
        const priceUrl = `${commerce}/commerce/v1/purchase/price_list`;
        const priceRes = await apiPost(priceUrl, { aid: 348188, goods_ids: ['credit'], goods_types: ['credit'] }, session, agent);
        const priceData = JSON.parse(priceRes.response || '{}');
        const prices = priceData.price_list || [];
        if (prices.length > 0) {
            for (const p of prices) {
                console.log(chalk.gray(`     ✦ ${p.number} credits = ${p.price_tips} (${p.currency_code})`));
            }
        } else {
            console.log(chalk.gray(`     No credit packages available`));
        }
    } catch (e) {}

    // === AI Benefits Summary ===
    console.log(chalk.cyan('\n  🧠 AI Benefits Summary:'));
    try {
        const benUrl = `${commerce}/commerce/v3/benefits/batch_get_user_benefit?aid=${APP_ID}`;
        const benRes = await apiPost(benUrl,
            { query_list: [{ resource_type: 'aigc', resource_id: 'get_all', benefit_type_list: [] }, { resource_type: 'normal_func', resource_id: 'get_all', benefit_type_list: [] }] },
            session, agent);
        const benData = JSON.parse(benRes.response || '{}');
        const assets = benData.asset_list || [];
        const unlimited = assets.filter(a => a.quota_all === -1);
        const limited = assets.filter(a => a.quota_all > 0 && a.quota_all !== -1);
        const zero = assets.filter(a => a.quota_all === 0);

        console.log(chalk.gray(`     Total Benefits:     ${assets.length}`));
        console.log(chalk.green(`     ∞ Unlimited:        ${unlimited.length}`));
        console.log(chalk.white(`     📊 Limited:         ${limited.length}`));
        console.log(chalk.gray(`     ❌ Not Available:    ${zero.length}`));

        if (unlimited.length > 0) {
            console.log(chalk.cyan('\n     Unlimited Features:'));
            // Group by category
            const categories = {};
            for (const a of unlimited) {
                const cat = a.resource_id.replace(/_/g, ' ');
                if (!categories[cat]) categories[cat] = [];
                categories[cat].push(a.benefit_type);
            }
            const catKeys = Object.keys(categories).slice(0, 20);
            for (const cat of catKeys) {
                console.log(chalk.gray(`     ✦ ${cat}`));
            }
            if (Object.keys(categories).length > 20) {
                console.log(chalk.gray(`     ... and ${Object.keys(categories).length - 20} more`));
            }
        }

        if (limited.length > 0) {
            console.log(chalk.cyan('\n     Limited Features:'));
            for (const a of limited) {
                console.log(chalk.gray(`     📊 ${a.resource_id} (${a.benefit_type}): ${a.quota_left}/${a.quota_all}`));
            }
        }
    } catch (e) {}

    console.log(chalk.cyan('\n═══════════════════════════════════════\n'));
}

// ═══════════════════════════════════
//  TOOL 7: CANCEL AUTO-RENEW (Pro + Team)
// ═══════════════════════════════════
// [CANCEL-RENEW v2] Uses commerce/v3/trade/subscription_infos (same as Account Info)
// to find subscription IDs, and user_info to know cancel status. Cancels both
// Personal Pro/VIP and Team subs via commerce/v3/trade/cancel_subscription.
async function toolCancelAutoRenew(session, ws, domains, agent, allWorkspaces) {
    const commerce = domains.api.replace('edit-api-sg', 'commerce-api-sg');

    console.log(chalk.cyan('\n═══════════════════════════════════════'));
    console.log(chalk.white('     🚫 CANCEL AUTO-RENEW'));
    console.log(chalk.cyan('═══════════════════════════════════════\n'));

    // ─── Step 1: user_info — gets Pro cancel status + Team cancel status per workspace ───
    console.log(chalk.gray('🔄 Reading subscription status...'));
    let proIsCancelled = false;
    let proIsActive = false;
    const teamCancelStatus = {}; // workspace_id -> bool (true = cancelled)
    try {
        const ui = await apiPost(`${commerce}/commerce/v1/subscription/user_info`,
            { aid: '348188', scene: 'vip' }, session, agent);
        const sub = JSON.parse(ui.response || '{}');
        if (sub.flag) {
            proIsActive = true;
            proIsCancelled = !!sub.is_cancel_subscribe;
        }
        const wsInfo = sub.workspace_subscribe_info;
        if (wsInfo?.ongoing_plans) {
            for (const p of wsInfo.ongoing_plans) {
                teamCancelStatus[p.workspace_id] = !!p.is_cancel_subscribe;
            }
        }
    } catch (e) { console.log(chalk.gray(`   (user_info: ${e.message})`)); }

    // ─── Step 2: subscription_infos — gets Sub IDs (same as Account Info uses) ───
    console.log(chalk.gray('📋 Fetching subscription IDs...'));
    let vipSubs = [], wsSubs = [];
    try {
        const payRes = await apiPost(`${commerce}/commerce/v3/trade/subscription_infos`,
            { scene: ['vip', 'workspace'], vip_levels: ['vip', 'svip'], app_id: 348188 }, session, agent);
        const payData = JSON.parse(payRes.response || '{}');
        vipSubs = payData.subscription_user_infos?.vip?.subscription_infos || [];
        wsSubs  = payData.subscription_user_infos?.workspace?.subscription_infos || [];
    } catch (e) {
        console.log(chalk.red(`❌ Failed to fetch subscriptions: ${e.message}`));
        return;
    }

    // ─── Step 3: Build unified list ───
    const allPlans = [];

    for (const s of vipSubs) {
        const sku = s.sku_info || {};
        if (!s.subscription_id) continue;
        allPlans.push({
            kind: 'Pro',
            product_name: sku.sku_name || sku.product_id || 'Pro Plan',
            subId: s.subscription_id,
            can_cancel: s.can_cancel !== false,
            is_cancelled: proIsCancelled,
            workspace_name: '',
            workspace_id: ''
        });
    }

    for (const s of wsSubs) {
        const sku = s.sku_info || {};
        if (!s.subscription_id) continue;
        const wsId = s.workspace_id || s.space_id || '';
        const wsName = (allWorkspaces || []).find(w => String(w.workspace_id) === String(wsId))?.name || `Workspace ${wsId}`;
        allPlans.push({
            kind: 'Team',
            product_name: sku.sku_name || sku.product_id || 'Team Plan',
            subId: s.subscription_id,
            can_cancel: s.can_cancel !== false,
            is_cancelled: teamCancelStatus[wsId] || false,
            workspace_name: wsName,
            workspace_id: wsId
        });
    }

    if (allPlans.length === 0) {
        console.log(chalk.yellow('\n⚠️  No subscriptions found.'));
        if (proIsActive) {
            console.log(chalk.gray('   (Pro is active but no Sub ID — may be a gift/trial without billing)'));
        }
        return;
    }

    // ─── Step 4: Display ───
    console.log(chalk.cyan('\n  📋 Subscriptions:\n'));
    allPlans.forEach((p, i) => {
        const status = p.is_cancelled
            ? chalk.green(' [ALREADY CANCELLED]')
            : chalk.yellow(' [AUTO-RENEW ACTIVE]');
        const tag = p.kind === 'Team' ? chalk.magenta('[Team]') : chalk.blue('[Pro] ');
        const ws_label = p.workspace_name ? chalk.gray(` — ${p.workspace_name}`) : '';
        console.log(chalk.white(`  ${i + 1}. ${tag} ${p.product_name}${ws_label}${status}`));
        console.log(chalk.gray(`     subId: ${p.subId}`));
    });

    const active = allPlans.filter(p => !p.is_cancelled);
    if (active.length === 0) {
        console.log(chalk.green('\n✅ All subscriptions already cancelled.'));
        return;
    }

    // ─── Step 5: Choose ───
    const ans = readlineSync.question(chalk.yellow(`\nCancel which? (number, comma-separated, "all", or "back"): `));
    if (!ans.trim() || ans.toLowerCase() === 'back') return;

    let targets = [];
    if (ans.toLowerCase() === 'all') {
        targets = active;
    } else {
        const idxs = ans.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        for (const idx of idxs) {
            const p = allPlans[idx - 1];
            if (!p) { console.log(chalk.red(`  ⚠️ #${idx} invalid`)); continue; }
            if (p.is_cancelled) { console.log(chalk.gray(`  ⚠️ #${idx} already cancelled, skipping`)); continue; }
            targets.push(p);
        }
    }

    if (targets.length === 0) { console.log(chalk.yellow('Nothing to cancel.')); return; }

    const confirm = readlineSync.question(chalk.yellow(`\nConfirm cancel ${targets.length} subscription(s)? (y/n): `));
    if (confirm.toLowerCase() !== 'y') return;

    // ─── Step 6: Execute cancel ───
    let ok = 0, fail = 0;
    for (const p of targets) {
        console.log(chalk.cyan(`\n  ❌ Cancelling: ${p.kind} — ${p.product_name}`));
        try {
            const r = await apiPost(`${commerce}/commerce/v3/trade/cancel_subscription`,
                { subscribe_id: p.subId, app_id: 348188 }, session, agent);
            let inner = {};
            try { inner = typeof r.response === 'string' ? JSON.parse(r.response) : (r.response || {}); } catch {}
            const success = String(r.ret) === '0' || inner.status === 'success';
            if (success) { console.log(chalk.green(`     ✅ CANCELLED`)); ok++; }
            else { console.log(chalk.yellow(`     ⚠️ ret=${r.ret} errmsg=${r.errmsg || ''}`)); fail++; }
        } catch (e) {
            console.log(chalk.red(`     ❌ ${e.message}`)); fail++;
        }
        await new Promise(r => setTimeout(r, 800));
    }

    // ─── Step 7: Verify ───
    console.log(chalk.cyan(`\n  🔍 Verifying...`));
    await new Promise(r => setTimeout(r, 1500));
    try {
        const ui = await apiPost(`${commerce}/commerce/v1/subscription/user_info`,
            { aid: '348188', scene: 'vip' }, session, agent);
        const sub = JSON.parse(ui.response || '{}');
        const newProCancelled = sub.flag ? !!sub.is_cancel_subscribe : false;
        const newTeamCancel = {};
        if (sub.workspace_subscribe_info?.ongoing_plans) {
            for (const p of sub.workspace_subscribe_info.ongoing_plans) {
                newTeamCancel[p.workspace_id] = !!p.is_cancel_subscribe;
            }
        }

        let verified = 0;
        for (const t of targets) {
            const nowCancelled = t.kind === 'Pro' ? newProCancelled : !!newTeamCancel[t.workspace_id];
            if (nowCancelled) verified++;
        }
        if (verified === targets.length) console.log(chalk.green(`  ✅ All ${verified} verified cancelled.`));
        else console.log(chalk.yellow(`  ⚠️ Verified ${verified}/${targets.length} — check Option 6 to confirm.`));
    } catch {}

    console.log(chalk.cyan(`\n📊 ${ok} cancelled, ${fail} failed`));
}


// ═══════════════════════════════════
//  TOOL 8: DELETE ACCOUNT (v3)
// ═══════════════════════════════════
// 4-step CapCut flow discovered via network sniffer:
//   1. GET  /passport/web/cancel/user_check/  → gets value_ticket
//   2. POST /lv/v1/web/cancel/check           → validates eligibility
//   3. POST /passport/web/account/authorize/  → password check, gets token
//   4. POST /passport/web/cancel/confirm/     → executes deletion
async function toolDeleteAccount(session, ownerEmail, ownerPassword, deviceId, domains, agent) {
    console.log(chalk.red('\n═══════════════════════════════════════'));
    console.log(chalk.red.bold('  🗑️  DELETE ACCOUNT — DANGER ZONE'));
    console.log(chalk.red('═══════════════════════════════════════\n'));

    console.log(chalk.yellow(`⚠️  Account:  ${ownerEmail}`));
    console.log(chalk.yellow(`⚠️  This will PERMANENTLY delete the account.`));
    console.log(chalk.yellow(`⚠️  Recovery: 30 days via CapCut Mobile app only.\n`));

    // ─── Double confirmation ───
    const c1 = readlineSync.question(chalk.yellow(`Type YES (uppercase) to continue: `));
    if (c1 !== 'YES') { console.log(chalk.green('✅ Cancelled')); return; }

    console.log(chalk.yellow(`\nFinal confirmation — type the full email:`));
    console.log(chalk.gray(`   Expected: ${ownerEmail}`));
    const c2 = readlineSync.question(chalk.yellow(`   Email: `));
    if (c2.trim().toLowerCase() !== ownerEmail.toLowerCase()) {
        console.log(chalk.red('❌ Email mismatch. Cancelled.'));
        return;
    }

    // ─── Extract CSRF token from cookies ───
    const csrfMatch = session.match(/passport_csrf_token(?:_default)?=([^;]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    if (!csrfToken) {
        console.log(chalk.red('❌ No CSRF token in session cookies. Cannot proceed.'));
        return;
    }

    // ─── Query params required by passport endpoints ───
    const baseParams = new URLSearchParams({
        aid: '348188',
        account_sdk_source: 'web',
        sdk_version: '2.1.10-tiktok',
        language: 'en',
        verifyFp: generateVerifyFp(),
        timezone_name: 'Africa/Cairo',
        webid: deviceId,
        browser_language: 'en-US',
        browser_name: 'Mozilla',
        browser_platform: 'Win32',
        browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        cookie_enabled: 'true',
        screen_height: '1080',
        screen_width: '1920'
    }).toString();

    const passportBase = 'https://www.capcut.com';
    const passportHeaders = {
        'appid': '348188',
        'Referer': 'https://www.capcut.com/settings',
        'x-tt-passport-csrf-token': csrfToken,
        'store-country-code': domains.regionParams,
        'store-country-code-src': 'uid',
        'did': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript',
        'cookie': session
    };

    try {
        // ─── Step 1: user_check ───
        console.log(chalk.cyan('\n[1/4] Checking if account can be deleted...'));
        const step1 = await axios.get(
            `${passportBase}/passport/web/cancel/user_check/?${baseParams}`,
            { headers: passportHeaders, httpsAgent: agent, timeout: 15000 }
        );
        const valueTicket = step1.data?.data?.value_ticket;
        if (!valueTicket) {
            throw new Error(step1.data?.data?.description || step1.data?.message || 'no value_ticket');
        }
        console.log(chalk.green(`     ✅ value_ticket: ${valueTicket.slice(0, 15)}...`));

        // ─── Step 2: validation ───
        console.log(chalk.cyan('[2/4] Validating deletion eligibility...'));
        const step2 = await apiPost(`${domains.api}/lv/v1/web/cancel/check`, {}, session, agent);
        if (step2.ret !== '0' || !step2.data?.pass) {
            const failures = (step2.data?.reason || []).filter(r => !r.pass);
            const msgs = failures.map(f => f.text || `type ${f.type}`).filter(Boolean);
            throw new Error(msgs.length ? msgs.join('; ') : (step2.errmsg || 'validation failed'));
        }
        console.log(chalk.green('     ✅ Validation passed'));

        // ─── Step 3: authorize with password ───
        console.log(chalk.cyan('[3/4] Authorizing with password...'));
        const encPass = Buffer.from(xorOperation(ownerPassword)).toString('hex');
        const step3 = await axios.post(
            `${passportBase}/passport/web/account/authorize/?${baseParams}`,
            new URLSearchParams({ mix_mode: '1', password: encPass }).toString(),
            {
                headers: { ...passportHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
                httpsAgent: agent, timeout: 15000
            }
        );
        const token = step3.data?.data?.token;
        if (!token) {
            throw new Error(step3.data?.data?.description || step3.data?.message || 'no token — wrong password?');
        }
        console.log(chalk.green(`     ✅ token: ${token.slice(0, 15)}...`));

        // ─── Step 4: confirm delete ───
        console.log(chalk.red('[4/4] EXECUTING DELETE...'));
        const step4 = await axios.post(
            `${passportBase}/passport/web/cancel/confirm/?${baseParams}`,
            new URLSearchParams({ value_ticket: valueTicket, token }).toString(),
            {
                headers: { ...passportHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
                httpsAgent: agent, timeout: 15000
            }
        );

        if (step4.data?.message === 'success') {
            console.log(chalk.green('\n═══════════════════════════════════════'));
            console.log(chalk.green.bold('  ✅ ACCOUNT DELETED SUCCESSFULLY'));
            console.log(chalk.green('═══════════════════════════════════════'));
            console.log(chalk.gray(`     Email:    ${ownerEmail}`));
            console.log(chalk.gray(`     Recovery: 30 days (CapCut Mobile app)`));
            console.log(chalk.gray(`     Session:  now invalid — please exit.\n`));
        } else {
            throw new Error(step4.data?.data?.description || step4.data?.message || 'unknown error');
        }
    } catch (err) {
        const detail = err.response?.data?.data?.description
                    || err.response?.data?.message
                    || err.message;
        console.log(chalk.red(`\n❌ Delete failed: ${detail}`));
    }
}

// ═══════════════════════════════════
//  MAIN MENU
// ═══════════════════════════════════
async function main() {
    console.log(chalk.cyan('\n═══════════════════════════════════════'));
    console.log(chalk.white('       CAPCUT TOOLS v2.2'));
    console.log(chalk.cyan('═══════════════════════════════════════\n'));

    const ownerEmail = readlineSync.question(chalk.yellow('Email: '));
    const ownerPassword = readlineSync.question(chalk.yellow('Password: '), { hideEchoBack: true });

    console.log(chalk.cyan('\nSelect region:'));
    console.log('  1. US');
    console.log('  2. ROW (Non-US)');
    const rc = readlineSync.question(chalk.yellow('Region (1/2): '));
    const isUS = rc === '1';

    const domains = isUS ? {
        login: 'https://login.us.capcut.com',
        api: 'https://web-edit.us.capcut.com',
        regionParams: 'us'
    } : {
        login: 'https://login-row.www.capcut.com',
        api: 'https://edit-api-sg.capcut.com',
        regionParams: 'sg'
    };

    let agent = null;
    const up = readlineSync.question(chalk.yellow('\nUse proxy? (y/n): '));
    if (up.toLowerCase() === 'y') {
        // Try to load from proxies.json first
        const proxiesFile = require('path').join(__dirname, 'proxies.json');
        let proxies = [];
        try { if (fs.existsSync(proxiesFile)) proxies = JSON.parse(fs.readFileSync(proxiesFile, 'utf8')); } catch (e) {}
        
        if (proxies.length > 0) {
            console.log(chalk.cyan('  Available proxies:'));
            proxies.forEach((p, i) => {
                const ps = p.proxyString || p;
                const label = ps.includes('cr.eg') ? 'EG' : ps.includes('cr.us') ? 'US' : ps.includes('cr.sa') ? 'SA' : ps.includes('cr.id') ? 'ID' : 'Other';
                console.log(chalk.gray(`  ${i + 1}. [${label}] ${ps.substring(0, 60)}...`));
            });
            console.log(chalk.gray(`  ${proxies.length + 1}. Manual input`));
            const pc = readlineSync.question(chalk.yellow(`  Select (1-${proxies.length + 1}): `));
            const pIdx = parseInt(pc) - 1;
            if (pIdx >= 0 && pIdx < proxies.length) {
                const proxyStr = proxies[pIdx].proxyString || proxies[pIdx];
                agent = new HttpsProxyAgent(proxyStr);
                console.log(chalk.green(`  ✅ Using proxy: ${proxyStr.substring(0, 40)}...`));
            } else {
                const ps = readlineSync.question(chalk.yellow('  Proxy (host:port:user:pass): '));
                const pp = ps.split(':');
                if (pp.length >= 4) agent = new HttpsProxyAgent(`http://${pp[2]}:${pp[3]}@${pp[0]}:${pp[1]}`);
                else if (pp.length >= 2) agent = new HttpsProxyAgent(`http://${pp[0]}:${pp[1]}`);
            }
        } else {
            const ps = readlineSync.question(chalk.yellow('  Proxy (host:port:user:pass): '));
            const pp = ps.split(':');
            if (pp.length >= 4) agent = new HttpsProxyAgent(`http://${pp[2]}:${pp[3]}@${pp[0]}:${pp[1]}`);
            else if (pp.length >= 2) agent = new HttpsProxyAgent(`http://${pp[0]}:${pp[1]}`);
        }
    }

    const deviceId = generateDeviceId();

    console.log(chalk.cyan('\n🔐 Logging in...'));
    let session, userData;
    try {
        const loginResult = await loginCapcut(ownerEmail, ownerPassword, domains, deviceId, agent);
        if (!loginResult) throw new Error('No session');
        session = loginResult.session;
        userData = loginResult.userData;
        console.log(chalk.green('✅ Login OK!'));
    } catch (err) {
        console.log(chalk.red(`❌ Login failed: ${err.message}`));
        return;
    }

    // Get workspaces
    console.log(chalk.cyan('\n📋 Getting workspaces...'));
    let workspaces = [];
    const commerce = domains.api.replace('edit-api-sg', 'commerce-api-sg');
    try {
        const res = await apiPost(`${domains.api}/cc/v1/workspace/get_user_workspaces`,
            { cursor: '0', count: 100, need_convert_workspace: true }, session, agent);
        workspaces = res.data?.workspace_infos || [];
        if (workspaces.length === 0) {
            console.log(chalk.yellow('⚠️ No workspaces found (free account without team)'));
        } else {
            console.log(chalk.green(`✅ Found ${workspaces.length} workspace(s):\n`));
            for (let i = 0; i < workspaces.length; i++) {
                const ws = workspaces[i];
                const available = ws.member_limit - ws.member_cnt;

                let expiryStr = 'Free';
                try {
                    const subRes = await apiPost(`${commerce}/commerce/v1/subscription/workspace/space_list`,
                        { aid: 348188, workspace_id: ws.workspace_id }, session, agent);
                    const subData = JSON.parse(subRes.response || '{}');
                    if (subData.space_list && subData.space_list.length > 0) {
                        expiryStr = formatDate(subData.space_list[0].space_end);
                    }
                } catch (e) {}

                console.log(chalk.white(`  ${i + 1}. ${ws.name}`));
                console.log(chalk.gray(`     👥 Members: ${ws.member_cnt}/${ws.member_limit} (${available} available)`));
                console.log(chalk.gray(`     📅 Expires: ${expiryStr}`));
                console.log(chalk.gray(`     🔑 Role: ${ws.role}`));
                console.log(chalk.gray(`     🌍 Region: ${ws.region || 'N/A'}`));
                console.log(chalk.gray(`     💾 Storage: ${formatStorage(ws.quota)}`));
                console.log(chalk.gray(`     🆔 ID: ${ws.workspace_id}`));
                console.log('');
            }
        }
    } catch (err) {
        console.log(chalk.red(`❌ Failed: ${err.message}`));
    }

    let wsIdx = 0;
    if (workspaces.length > 1) {
        wsIdx = parseInt(readlineSync.question(chalk.yellow('Select workspace: '))) - 1;
    }
    const ws = workspaces[wsIdx] || null;

    // Main menu loop
    while (true) {
        const wsName = ws ? ws.name : 'No workspace';
        const available = ws ? ws.member_limit - ws.member_cnt : 0;

        console.log(chalk.cyan('\n═══════════════════════════════════════'));
        console.log(chalk.white(`  📌 ${wsName}`));
        if (ws) console.log(chalk.gray(`  👥 ${ws.member_cnt}/${ws.member_limit} (${available} available) | 🌍 ${ws.region || 'N/A'}`));
        console.log(chalk.cyan('═══════════════════════════════════════'));
        console.log(chalk.white('  1. 🗑️  Remove Members'));
        console.log(chalk.white('  2. ✏️  Rename Workspace'));
        console.log(chalk.white('  3. 📧  Invite by Email'));
        console.log(chalk.white('  4. 👥  View Members'));
        console.log(chalk.white('  5. 🔗  Get Invite Link'));
        console.log(chalk.white('  6. 📋  Full Account Info'));
        console.log(chalk.white('  7. 🚫  Cancel Auto-Renew'));
        console.log(chalk.white('  8. 🗑️  Delete Account'));
        console.log(chalk.white('  9. ❌  Exit'));
        console.log(chalk.cyan('═══════════════════════════════════════'));

        const choice = readlineSync.question(chalk.yellow('\nSelect (1-9): '));

        if (!ws && ['1','2','3','4','5'].includes(choice)) {
            console.log(chalk.red('❌ No workspace selected'));
            continue;
        }

        switch (choice) {
            case '1': await toolRemoveMembers(session, ws, domains, agent); break;
            case '2': await toolRenameWorkspace(session, ws, domains, agent); break;
            case '3': await toolInviteByEmail(session, ws, domains, agent); break;
            case '4': await toolViewMembers(session, ws, domains, agent); break;
            case '5': await toolGetInviteLink(session, ws, domains, agent); break;
            case '6': await toolAccountInfo(session, ws, domains, agent, userData, workspaces, deviceId); break;
            case '7': await toolCancelAutoRenew(session, ws, domains, agent, workspaces); break;
            case '8': await toolDeleteAccount(session, ownerEmail, ownerPassword, deviceId, domains, agent); break;
            case '9': console.log(chalk.cyan('\n👋 Bye!\n')); return;
            default: console.log(chalk.red('❌ Invalid choice'));
        }
    }
}

main().catch(err => console.error(chalk.red(`Fatal: ${err.message}`)));
