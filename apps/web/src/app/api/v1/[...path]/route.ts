import { serveApiRequest } from "@/lib/api/handler";

/**
 * The versioned public API's one entry point (phase 32).
 *
 * A catch-all route rather than a file per endpoint, because the route table and the
 * documentation are then the same object: `lib/api/routes.ts` is dispatched from here and
 * rendered by `/docs/api`. Adding a route means adding one entry, and there is no file tree
 * that can drift from the page that describes it.
 */

type Context = { params: Promise<{ path?: string[] }> };

async function pathOf(context: Context): Promise<string[]> {
  const params = await context.params;
  return params.path ?? [];
}

export async function GET(request: Request, context: Context) {
  return serveApiRequest({ request, method: "GET", path: await pathOf(context) });
}

export async function POST(request: Request, context: Context) {
  return serveApiRequest({ request, method: "POST", path: await pathOf(context) });
}
