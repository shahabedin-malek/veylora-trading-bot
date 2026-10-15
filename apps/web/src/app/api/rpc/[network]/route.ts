import { handleNetworkRpcPost } from "@/lib/rpc/rpc-proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ network: string }> },
) {
  const { network } = await context.params;
  return handleNetworkRpcPost(request, network);
}
