# backstop-scanner

Security scanner for Next.js + Supabase repos

> **Badge:** Built for vibe coders who ship fast

## What it catches

1. `.env` files that are not listed in `.gitignore`.
2. Client-side files (`/components`, `/app`, `/pages`) that import `createClient` from `@supabase/supabase-js` and use `SUPABASE_SERVICE_ROLE_KEY`.
3. Hardcoded Supabase credential-like JWT strings in source files (`.ts`, `.tsx`, `.js`, `.jsx`), excluding `.env`, `.git`, and `node_modules`.
4. Supabase `.from('table')` queries where the table name has no mention in any file under `supabase/migrations`.
5. API route files (`/app/api`, `/pages/api`) that use `SUPABASE_SERVICE_ROLE_KEY` with no visible auth check (`getServerSession`, `auth()`, `currentUser()`, `verifyToken`, or `Authorization`).

## Install

```bash
npm install
npm run build
```

## Usage

```bash
node dist/index.js <folder-path>
```

Example:

```bash
node dist/index.js .
```

## Example output

```text
Issues found:
- .env: .env file is not listed in .gitignore
- app/dashboard/page.tsx: Potential client-side exposure: imports createClient from @supabase/supabase-js and uses SUPABASE_SERVICE_ROLE_KEY
- lib/supabase/client.ts: Hardcoded Supabase credential-like JWT string found in source file
- app/api/reports/route.ts: reports table queried with no RLS migration found
- pages/api/admin.ts: API route uses service role key with no visible auth check
```
