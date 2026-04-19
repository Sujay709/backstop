# backstop-scanner

> Security scanner for Next.js + Supabase repos. 
> Built for vibe coders who ship fast.

## Usage

Point it at any Next.js + Supabase project:

```bash
npx backstop-scanner .
```

Or scan a specific folder:

```bash
npx backstop-scanner ./my-app
```

## What it catches

1. `.env` files not listed in `.gitignore`
2. Supabase service role key used in client-side files
3. Hardcoded JWT credentials in source files
4. Database tables queried with no RLS migration found
5. API routes using service role key with no auth check

## Example output
