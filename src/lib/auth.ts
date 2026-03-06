interface AuthResult {
  valid: boolean;
  error?: string;
}

export function verifyApiKey(authHeader: string | null): AuthResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, error: "Missing or malformed Authorization header" };
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return { valid: false, error: "Server misconfigured: missing API_KEY" };
  }

  const provided = authHeader.slice(7);
  if (!provided || provided !== apiKey) {
    return { valid: false, error: "Invalid API key" };
  }

  return { valid: true };
}
