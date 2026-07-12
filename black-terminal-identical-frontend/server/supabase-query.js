export async function settleSupabaseQuery(query) {
  try {
    return await query;
  } catch {
    return null;
  }
}
