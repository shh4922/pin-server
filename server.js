import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from "axios";
import fs from "fs";

const {
    PAYPAL_CLIENT_ID,
    PAYPAL_SECRET,
    PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com',
    EXPECTED_PLAN_ID,
    PORT = 443,
} = process.env;

const app = express();

const CLIENT_ID = "AUHCFgRW81GY2iQjQmJF8tHWLjl0-TxGfCjjpmbpXs3AU9_8Ea3DjjiNqFGDoCg7_PkHLP4-wT6t6k9n"
const SECRET    = "EG1G_olUfmpk3lj_y7Pe5ukC4ThNUAhfdkXPloGz55hPZEnIF5_w0ODKRx9sjEQ3wBfIbfI0GEWddv6m"


/**
 * 웹훅은 원래 raw body가 필요하지만,
 * 우선 데모라서 일반 JSON으로 받고 서명검증은 생략.
 * (실서비스에선 서명검증 필수!)
 */
app.use(cors());
app.use(express.json({ type: '*/*' }));

/** 메모리 DB (데모용) */
const users = new Map();          // key: email, value: { email, subscriptionId, status, planId }
const subs  = new Map();          // key: subscriptionId, value: last payload




/**  로그 저장 유틸  */
function saveLog(label, data) {
    const line = `[${new Date().toISOString()}] ${label}\n` +
        JSON.stringify(data, null, 2) + "\n\n";
    fs.appendFileSync("server.log", line, "utf8");
    console.log(line); // 콘솔에도 찍기
}

/** 유틸: PayPal Access Token 받기 */
async function getAccessToken() {
    const { data } = await axios.post(`${BASE}/v1/oauth2/token`, "grant_type=client_credentials", {
        auth: { username: CLIENT_ID, password: SECRET },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    return data.access_token;
}

/** 디버그: 헬스체크 */
app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * onApprove 이후 클라이언트가 호출:
 * body: { email, subscriptionId }
 * → PayPal API로 구독 상태 확인 후 메모리DB에 저장
 */
app.post('/api/subscriptions/confirm', async (req, res) => {
    try {
        const { email, subscriptionId } = req.body || {};
        if (!email || !subscriptionId) {
            return res.status(400).json({ ok: false, error: 'email, subscriptionId required' });
        }

        const token = await getAccessToken();
        const r = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const sub = await r.json();

        // 간단 검증
        const status = sub.status;            // APPROVAL_PENDING, ACTIVE, CANCELLED 등
        const planId = sub.plan_id;

        // 기대 플랜이면 더 안전
        if (EXPECTED_PLAN_ID && planId !== EXPECTED_PLAN_ID) {
            return res.status(400).json({ ok: false, error: `Unexpected plan_id ${planId}` });
        }

        // ACTIVE가 아니어도 우선 저장 (웹훅으로 이후 상태 갱신될 수 있음)
        users.set(email, { email, subscriptionId, status, planId, updatedAt: new Date().toISOString() });
        subs.set(subscriptionId, sub);

        return res.json({ ok: true, status, planId, subscriptionId });
    } catch (e) {
        console.error('[confirm] error', e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

/** 내 구독/권한 조회 (데모) */
app.get('/me/entitlements', (req, res) => {
    // 데모에선 쿼리로 email을 받음. 실제로는 JWT 등 인증 사용.
    const email = req.query.email;
    const row = email ? users.get(email) : null;
    const pro = !!row && row.status === 'ACTIVE';
    res.json({ pro, detail: row || null });
});


/**
 * PayPal Webhook 수신 (데모)
 * 실서비스: PayPal-Transmission-Id/Time/Sig + Cert-Url 로 서명검증 필수
 */
app.post("/paypal/webhook", express.json({ type: "*/*" }), async (req, res) => {
    const event = req.body;

    // 👉 로그를 파일에도 남김
    saveLog("WEBHOOK EVENT", event);

    try {
        const type = event.event_type;
        console.log("[WEBHOOK]", type, event?.resource?.id);

        if (type?.startsWith("BILLING.SUBSCRIPTION.") || type === "PAYMENT.SALE.COMPLETED") {
            const resource = event.resource || {};
            const subscriptionId =
                resource.id ||
                resource.billing_agreement_id ||
                resource.subscription_id ||
                null;

            if (subscriptionId) {
                // 최신 상태 재조회
                const token = await getAccessToken();
                const r = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const sub = await r.json();

                saveLog("SUBSCRIPTION FETCH", sub); // 📝 구독 상세도 저장

                // DB 업데이트 로직 (예시)
                for (const [k, v] of users.entries()) {
                    if (v.subscriptionId === subscriptionId) {
                        users.set(k, {
                            ...v,
                            status: sub.status,
                            planId: sub.plan_id,
                            updatedAt: new Date().toISOString(),
                            lastEvent: type,
                        });
                    }
                }
            }
        }
    } catch (e) {
        saveLog("WEBHOOK ERROR", { error: e.message });
        console.error("[webhook] update error", e);
    }

    res.sendStatus(200);
});

/** 디버그용: 구독 원본 보기 */
app.get('/debug/subscriptions/:id', (req, res) => {
    return res.json(subs.get(req.params.id) || null);
});

app.listen(Number(PORT), () => {
    console.log(`Server running on http://localhost:${PORT}`);
});