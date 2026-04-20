# backstop-scanner

[![npm version](https://img.shields.io/npm/v/backstop-scanner)](https://www.npmjs.com/package/backstop-scanner)

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

## GitHub Actions (CI integration)

Add this to `.github/workflows/backstop.yml` in your repo:

    name: Backstop Security Scan
    on: [pull_request]
    jobs:
      scan:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v3
          - run: npx backstop-scanner . --exit-code

The `--exit-code` flag makes the PR check fail automatically
when HIGH severity issues are found.

## What it catches

1. .env not in .gitignore - flags .env files that could be accidentally committed
2. Client-side service role key - catches SUPABASE_SERVICE_ROLE_KEY in /components /app /pages
3. Hardcoded JWT credentials - finds hardcoded Supabase keys in source files
4. Missing RLS migration - flags tables queried with no matching RLS migration file
5. Unprotected service role API route - API routes using service role key with no auth check
6. Unauthenticated client writes - client components writing to DB with no auth check

## Example output

    [HIGH] - components/footer-primary.tsx: client component writes directly to database with no visible auth check
    [LOW]  - components/footer-primary.tsx: user_email_list table queried with no RLS migration found
    [HIGH] - pages/api/admin.ts: API route uses service role key with no visible auth check
    [HIGH] - lib/supabase/client.ts: hardcoded Supabase JWT credential

    Found 4 issues: 3 high, 0 medium, 1 low

## Real world example

Ran backstop-scanner on a popular open source Next.js + Supabase
starter kit and found a HIGH severity issue in seconds — a client
component inserting directly into a database table with no auth
check and no RLS policy.

## Stack support

Next.js App Router and Pages Router, Supabase, works with Cursor
and any AI coding tool

## Contributing

Rules live in src/index.ts. PRs welcome.
Built by Sujay709 - github.com/Sujay709/backstop