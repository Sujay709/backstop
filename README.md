# backstop-scanner

Security scanner for Next.js + Supabase repos.
Built for vibe coders who ship fast.

## Quickstart (no install needed)

    npx backstop-scanner .

## Install globally

If you want to run it repeatedly without npx:

    npm install -g backstop-scanner
    backstop-scanner .

## Install locally in a project

    npm install --save-dev backstop-scanner
    npx backstop-scanner .

## Clone and run from source

    git clone https://github.com/Sujay709/backstop
    cd backstop
    npm install
    npm run build
    node dist/index.js <path-to-your-project>

## Usage

    npx backstop-scanner .
    npx backstop-scanner ./my-app
    npx backstop-scanner C:\projects\my-saas

## What it catches

1. .env not in .gitignore - flags .env files that could be accidentally committed
2. Client-side service role key - catches SUPABASE_SERVICE_ROLE_KEY in /components /app /pages
3. Hardcoded JWT credentials - finds hardcoded Supabase keys in source files
4. Missing RLS migration - flags tables queried with no matching RLS migration file
5. Unprotected service role API route - API routes using service role key with no auth check

## Example output

    Issues found:
    - .env: .env file is not listed in .gitignore
    - app/dashboard/page.tsx: client-side service role key exposure
    - lib/supabase/client.ts: hardcoded Supabase JWT credential
    - app/api/reports/route.ts: reports table queried with no RLS migration found
    - pages/api/admin.ts: API route uses service role key with no visible auth check

## Stack support

Next.js App Router and Pages Router, Supabase, works with Cursor and any AI coding tool

## Contributing

Rules live in src/index.ts. PRs welcome.
Built by Sujay709 - github.com/Sujay709/backstop
