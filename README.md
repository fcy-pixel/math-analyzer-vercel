# 數學學生表現分析系統 (math-analyzer-vercel)

上傳全班學生試卷 PDF → AI 逐份批改 → 自動生成全班弱點診斷報告與針對性練習。
前端 Next.js（`app/`），AI 批改透過阿里雲 Qwen 視覺 / 文字模型，部署於 Cloudflare Pages。

## 開發

```bash
npm install
npm run dev          # 本機開發 (http://localhost:3000)
npx tsc --noEmit     # 型別檢查
npm run build        # 建置
npm run deploy       # 建置並部署到 Cloudflare Pages
```

## 環境變數

在 Cloudflare Pages（Settings → Environment variables）設定：

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `QWEN_API_KEY` | ✅ | 阿里雲 DashScope API key，供 AI 批改使用。 |
| `SESSION_SECRET` | 建議 | **啟用後端登入驗證的開關。** 設定一段夠長的隨機字串（例如 `openssl rand -base64 32`）即會啟用 — 之後所有 `/api/*` AI 端點都必須帶有效的伺服器 session cookie 才能呼叫。**未設定時，API 端點不設防**（行為與舊版相同，方便漸進式上線）。 |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | 選填 | Google 登入 client id；不設定則用程式內預設值。 |
| `AUTH_GOOGLE_CLIENT_ID` | 選填 | 伺服器端驗證 Google token 時使用的 audience；預設沿用上面的值。 |

### 登入驗證如何運作

1. 使用者用 `@keitsz.edu.hk` Google 帳號登入（[`app/AuthGate.tsx`](app/AuthGate.tsx)）。
2. 前端把 Google ID token 送到 `POST /api/auth`，伺服器以 Google 公鑰驗證簽章、檢查 audience 與 hosted domain，通過後簽發一個 HttpOnly session cookie（預設 30 天，見 [`lib/auth.ts`](lib/auth.ts)）。
3. 各 AI 端點以 `requireAuth()` 檢查此 cookie，未通過回 401。

> ⚠️ 在設定 `SESSION_SECRET` 之前，任何人都能直接呼叫 `/api/analyze-student` 等端點並消耗你的 Qwen 額度。正式環境請務必設定。

### 設定 SESSION_SECRET 並重新部署（一次性）

```bash
# 1. 產生隨機密鑰並寫入 Pages production secret（會提示貼上值）
openssl rand -base64 32 | npx wrangler pages secret put SESSION_SECRET --project-name math-analyzer-vercel

# 2. 重新部署，讓 functions 讀到新變數
npm run deploy

# 3. 驗證：未帶 cookie 應回 401
curl -s -X POST https://math-analyzer-vercel.pages.dev/api/analyze-student \
  -H "Content-Type: application/json" -d '{"images":[]}'
# → {"error":"未登入或登入已過期，請重新登入。","auth_required":true}
```

> 之後若更改或刪除 `SESSION_SECRET`，已登入使用者的舊 cookie 會失效，需要重新登入一次（預期行為）。
