# توثيق كامل — عملية تغيير إيميل CapCut (Web API)

> ملف مرجعي شامل لكل ما تم اكتشافه أثناء محاولة أتمتة تغيير البريد الإلكتروني لحسابات CapCut عبر الـ Web API.

---

## 1. الملخص التنفيذي (أين وصلنا)

| الخطوة | الوصف | الحالة |
|---|---|---|
| **[0]** | تأكيد الهوية بالباسورد | ✅ يعمل 100% |
| **[1]** | إرسال كود للإيميل القديم | ✅ يعمل 100% |
| **[2]** | تأكيد كود القديم → verify_ticket | ✅ يعمل 100% |
| **[3]** | إرسال كود للإيميل الجديد | ⚠️ يعمل جزئياً (النوع الصح بلا template في الويب) |
| **[4]** | التغيير النهائي | ❌ متوقف (يعتمد على [3]) |

**الخلاصة:** كل البنية التحتية للعملية اتفكّت واشتغلت. العائق الوحيد: النوع الصحيح لإرسال كود الإيميل الجديد (`type=101`) **ليس له template في الـ Web API** — وهذا مؤشر قوي أن هذه الخطوة تحديداً **متاحة فقط في تطبيق الموبايل**.

---

## 2. العملية الكاملة (كما اكتُشفت)

مطابقة تماماً للعملية اليدوية في التطبيق:
> تحقق من البريد الحالي (كود) → تكتب الكود → يطلب الإيميل الجديد → يوصل كود عليه → تأكيد → تم التغيير

### التسلسل التقني الكامل

```
[0] POST /passport/web/account/verify/
    body: { mix_mode:1, password:<XOR-hex> }
    → { data: { ticket: "VTISGO..." } }     ← ticket الهوية (baseTicket)

[1] POST /passport/web/email/send_code/
    body: { mix_mode:1, email:<القديم XOR-hex>, type:6, is6Digits:1 }
    → { data: { email_ticket: "..." } }  + كود يصل على الإيميل القديم

[2] POST /passport/web/email/verify/
    body: { code:<code1>, email_ticket:<et1>, type:6 }   ← بدون mix_mode
    → { data: { ticket: "VTISGO..." } }     ← verify_ticket (المفتاح الأساسي)

[3] POST /passport/web/email/send_code/       ← العائق هنا
    الصحيح: { email:<الجديد>, type:101, verify_ticket:<من [2]> }
    → لكن type=101 يرجع 1355 "Template doesn't exist" في الـ Web

[4] POST /passport/web/email/change/
    body: { email:<الجديد>, code:<code2>, ticket:<verify_ticket>, email_ticket:<et2>, type:101 }
    → لم نصل إليها لأن [3] لا يرسل كوداً صالحاً
```

---

## 3. الاكتشافات المفتاحية (بالترتيب الزمني)

### 3.1 أسماء الـ Endpoints الصحيحة (من الكود المصدري)
مستخرجة من ملفات JavaScript الخاصة بـ CapCut passport SDK:
```js
SEND_EMAIL_CODE   = /passport/web/email/send_code/
VERIFY_EMAIL_CODE = /passport/web/email/verify/      ← ليس check_code!
CHECK_EMAIL_CODE  = /passport/web/email/check_code/
EMAIL_REBIND      = /passport/web/email/change/       ← هذا هو التغيير
ACCOUNT_VERIFY    = /passport/web/account/verify/
```

### 3.2 الأنواع (types) الصحيحة لكل خطوة
| الخطوة | النوع | ملاحظة |
|---|---|---|
| إرسال كود القديم | `type=6` + `is6Digits=1` | يعمل |
| تأكيد كود القديم | `type=6` (بدون mix_mode) | يعمل |
| إرسال كود الجديد | `type=101` | **الصحيح، لكن بلا template في الويب** |
| `type=8` للجديد | يرسل كوداً يصل فعلاً | **لكن الكود مرفوض في التغيير (1703)** |

### 3.3 أسماء الحقول للـ tickets
- الـ ticket من `account/verify` اسمه **`ticket`** (ليس `verify_ticket`)
- في خطوة verify يُرسل الـ ticket باسم **`email_ticket`**
- في خطوة change، الـ ticket القديم يُرسل باسم **`ticket`** (وليس `verify_ticket` — هذا أعطى 1708)

### 3.4 التشفير (Encoding)
الإيميل والباسورد يُشفّران بـ XOR ثم Hex (نفس آلية الـ login):
```js
function xorOperation(text, key = 5) {
    return [...text].map(c => String.fromCharCode(c.charCodeAt(0) ^ key)).join('');
}
const encoded = Buffer.from(xorOperation(text)).toString('hex');
```

---

## 4. النقطة الحاسمة: قراءة الكود تلقائياً (generator.email)

**هذا ما جعل كل شيء يعمل بسلاسة.** بدل كتابة الكود يدوياً، نقرأه تلقائياً عبر WebSocket.

### الاتصال
```
wss://generator.email/notificon/ws?email=<الإيميل الكامل>
```
مع headers:
```
Origin: https://generator.email
User-Agent: Mozilla/5.0 ...
```

### شكل الرسالة الواردة
```json
{
  "type": "mail",
  "channel": "user@domain.com",
  "email": "user@domain.com",
  "subject": "508513",              ← الكود غالباً في الـ subject مباشرة
  "from": "admin@mail.capcut.com",
  "date": "2026-09-26 03:30:23",
  "link": "domain.com/user/..."
}
```

### استخراج الكود
```js
const m = `${subject} ${body}`.match(/\b(\d{6})\b/);  // أو \d{4,6}
```

### نصائح عملية مهمة
1. **افتح الـ WebSocket قبل إرسال الطلب** — وإلا قد يصل الكود قبل أن تبدأ الاستماع فتفوته.
2. **فلتر على `from` يحتوي capcut** — الموقع يرسل رسائل heartbeat وتأكيد اتصال، خذ فقط رسالة CapCut.
3. **عالج انتهاء المهلة (timeout) بأمان** — لا ترمِ خطأ يوقف السكريبت، أرجع `null`.
4. **الإيميل الجديد لازم يكون على دومين مربوط بـ generator.email** — حتى نقرأ كوده تلقائياً أيضاً.

---

## 5. مشكلة الـ Rate Limiting (وكيف تعاملنا معها)

### الأخطاء
| كود الخطأ | المعنى |
|---|---|
| `1206` | Maximum attempts — عدّاد الإرسال ممتلئ |
| `7` | نفس المعنى (صيغة أخرى) |

### الملاحظات
- عدّاد الإرسال **لكل حساب/جلسة** — يُسمح بعدد محدود من `send_code` في نافذة زمنية قصيرة.
- إرسال كود القديم [1] ثم الجديد [3] بسرعة → يملأ العدّاد → `1206`.
- **الحل:** انتظار ~60-65 ثانية بين الإرسالين يصفّر العدّاد (على الحسابات النظيفة).

### استراتيجية الحسابات المتعددة
لتفادي حرق حساب واحد + الكود one-shot:
- استخدام عدة حسابات، كل حساب يجرّب فرضية/صيغة مختلفة.
- كل حساب يأخذ كوداً fresh وعدّاد rate limit منفصل.
- الإيميل الجديد = القديم + 3 أحرف عشوائية (نفس الدومين) لضمان أنه fresh.

---

## 6. جدول أكواد الأخطاء (مرجع)

| الكود | الرسالة | المعنى في سياقنا |
|---|---|---|
| `1031` | Enter a valid email | الإيميل غير مشفّر/مفقود |
| `1066` | Session expired | الـ ticket في الخانة الخطأ |
| `1204` | Something went wrong | نوع (type) خاطئ |
| `1206` / `7` | Maximum attempts | عدّاد الإرسال ممتلئ |
| `1320` | Email already linked | محاولة ربط إيميل مسجّل |
| `1355` | Template doesn't exist | **لا يوجد template لهذا النوع/المنطقة** |
| `1703` | Code expired/incorrect | الكود مستهلك أو غير مقبول في هذا السياق |
| `1704` | Code expired/incorrect | الكود مستهلك (one-shot) |
| `1708` | Email ticket is invalid | شكل/اسم الـ ticket خاطئ |
| `10009` | Illegal parameters | تركيبة parameters متعارضة |

---

## 7. العائق النهائي بالتفصيل

### ما جرّبناه في [3] (إرسال كود الجديد)
| النوع | النتيجة |
|---|---|
| `type=101` (الصحيح للتغيير) | `1355 Template doesn't exist` — في **كل** المناطق واللغات |
| `type=8` | `success` + **الكود يصل فعلاً**، لكنه مرفوض في التغيير (`1703`) |
| `type=6` | `success` لكن **بدون وصول كود** (phantom) |
| `type=4` | `success` phantom (بدون كود) |
| `type=9` | `1355` |
| `type=16/17/35` | `1204 Type error` |

### مسح المناطق واللغات لـ type=101
جُرّبت 12 منطقة × 7 لغات. **جميعها أرجعت `1355`** (باستثناء ظهور `1206` العابر الناتج عن امتلاء العدّاد من كثرة المحاولات السريعة، وليس دليلاً على وجود template).

### الاستنتاج
- `type=101` هو النوع الصحيح (اسمه في الـ SDK: `sendEmailCodeToNewManager`).
- لكن **الـ template الخاص به غير موجود في الـ Web API** — لا يُرسل بريداً.
- `type=8` يرسل بريداً، لكن كوده مربوط بسياق مختلف (bind وليس change) → مرفوض في `email/change`.

**النتيجة: خطوة إرسال كود الإيميل الجديد لتغيير البريد متاحة فقط عبر تطبيق الموبايل (Mobile API)، وليست مفعّلة في الـ Web API.** وهذا يفسّر لماذا الخاصية مخفية أصلاً في واجهة الويب.

---

## 8. الخطوة التالية المقترحة: Mobile API

للتجاوز، ننتقل من Web API إلى Mobile API. الفروق المطلوبة:
- `appId` مختلف (تطبيق الموبايل بدل الويب `348188`)
- `sdk_version` الخاص بالموبايل
- آلية توقيع (signing) وheaders الموبايل
- على الأرجح `type=101` سيعمل هناك لأن الـ templates كاملة في الموبايل

**المطلوب للبدء:** capture لترافيك تطبيق CapCut على الموبايل (عبر HTTP Toolkit / Charles / mitmproxy) — حتى لو لعملية login فقط — لاستخراج `appId` وheaders والـ signing الخاصة بالموبايل.

---

## 9. ما يعمل بشكل مؤكد (جاهز للبناء عليه)

```
✅ Login (email + password، XOR-hex)
✅ account/verify(password) → ticket
✅ send_code(القديم, type=6, is6Digits=1) → email_ticket + كود
✅ قراءة الكود تلقائياً من generator.email (WebSocket)
✅ email/verify(code, email_ticket, type=6, بدون mix_mode) → verify_ticket
✅ send_code(الجديد, type=8) → كود يصل فعلاً (لكن للـ bind لا للـ change)
✅ التعامل مع rate limit عبر الانتظار
✅ استراتيجية الحسابات المتعددة + توليد إيميل جديد fresh
```

## 10. ما تبقّى

```
⏳ [3] إرسال كود صالح للتغيير للإيميل الجديد → يحتاج Mobile API
⏳ [4] email/change → يعتمد على [3]
```

---

## 11. مشكلة سابقة محلولة: AI Credits والـ "login error" القديم (النقط)

> هذا القسم يوثّق مشكلة منفصلة تم حلّها في نفس مسار العمل، ولها أهمية لأن الدروس المستفادة منها (خاصة الـ APPVR والـ headers) قد تفيد في نهج الموبايل.

### 11.1 المشكلة
عند قراءة رصيد الـ AI Credits، كان endpoint الرصيد يرجع خطأ مضلّل:
```
"login error" (ret: 34010105)
```
مع بيانات مصفّرة (`credit: { vip_credit: 0, ... }`) رغم أن الحساب عليه رصيد فعلي.

### 11.2 السبب الجذري
السكريبت كان يرسل `appvr: 5.8.0` (قديم)، بينما متصفح CapCut يرسل `appvr: 12.4.0`.
- endpoint `commerce/v1/benefits/user_credit` **يرفض الـ appvr القديم تحديداً** ويرجع "login error" بدل خطأ حقيقي.
- باقي الـ endpoints كانت تقبل الـ appvr القديم — لذلك **فشل هذا الـ endpoint وحده**، مما جعل التشخيص أصعب.

### 11.3 الحل
**أ) تحديث الـ APPVR:**
```js
const APPVR = '12.4.0';  // كان 5.8.0
```

**ب) إضافة headers كانت ناقصة:**
```
appId, did, web_id, tdid, loc,
store-country-code, store-country-code-src
```

**ج) تمرير معلومات إضافية للـ credit endpoints:**
```js
const credExtra = { deviceId, region: acctRegion };
// deviceId → يضبط did, web_id, tdid
// region   → يضبط loc, store-country-code, store-country-code-src
```

### 11.4 التوقيع (Signing) — مهم
صيغة التوقيع تعتمد على الـ appvr، لذا يجب أن يكون `12.4.0`:
```
md5( 9e2c | urlLast7 | pf | appvr | deviceTime || 11ac )
```

### 11.5 فهم بنية البيانات الصحيح
نقطة مهمة كانت سبب لبس:
- **`residual_credits`** (داخل `credits_detail.vip_credits[]`) = **الرصيد الحقيقي المتبقي** (ما يعرضه CapCut).
- الحقول `vip_credit / gift_credit / purchase_credit` (في `credit` العلوي) = **إجماليات مخصّصة، وليست رصيداً**.
- `user_credit_history` type 1 = منح (grants)، type 2 = استهلاك (consumption).
- إجمالي الممنوح = مجموع سجلات type-1 (باستثناء `CheckFailed` التي تم استردادها).
- `pop_up.teams_amount` = مبلغ مرجعي للخطة، **وليس رصيد الحساب**.

### 11.6 الـ Pagination
سجل الـ history يُجلب عبر حلقة pagination (cursor-based) لجلب **كل الصفحات**، وليس أول 20 فقط. سجلات `CheckFailed` تُستبعد من الإجماليات (لأنها استُردّت).

### 11.7 ترجمة الليبلات (عربي/صيني → إنجليزي)
CapCut يرجع أسماء بلغات مختلفة حسب المنطقة، فتُترجم:
- `Teams (عضو المساحة)` → "Teams (space member)"
- `معمل الذكاء الاصطناعي` → "AI Lab"
- `智能编辑` → "Smart edit"
- أي نص غير ASCII غير معروف → يُنظّف/يُعلَّم.

### 11.8 النتيجة (تم التحقق)
على حساب برصيد 1600 (عضو Teams، منطقة PH):
```
🤖 AI Credits:
   Available Now:  20        ← الرصيد الحقيقي (residual_credits)
   By source: 20 — Teams (space member)

📜 Credit History:
   Total Granted:   1600
   Total Consumed:  1580
   Remaining (calc): 20      ← مطابق للرصيد الحقيقي
```

### 11.9 الدرس المستفاد (وأهميته للموبايل)
الـ **APPVR والـ headers الكاملة (did, web_id, tdid, loc, store-country-code)** كانت مفتاح تشغيل endpoint حسّاس رفض الطلبات الناقصة. نفس المبدأ قد ينطبق على نهج الموبايل: **الـ headers والإصدارات الصحيحة قد تكون الفرق بين "template doesn't exist" وبين نجاح الطلب.** يستحق التحقق مما إذا كان تعديل `appvr` أو `sdk_version` أو headers الجهاز قد يفعّل template الـ type=101 المفقود.

---

*آخر تحديث: 2026-09-26 — جلسة تفكيك عملية تغيير إيميل CapCut + مرجع مشكلة AI Credits*
