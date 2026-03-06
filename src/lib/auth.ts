import { jwtVerify, importSPKI } from "jose";

interface AuthResult {
  valid: boolean;
  error?: string;
  payload?: Record<string, any>;
}

export async function verifyJWT(authHeader: string | null): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, error: "Missing or malformed Authorization header" };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return { valid: false, error: "Missing or malformed Authorization header" };
  }

  const algorithm = process.env.JWT_ALGORITHM || "HS256";

  try {
    let key: any;

    if (algorithm === "RS256") {
      const publicKeyPem = process.env.JWT_PUBLIC_KEY;
      if (!publicKeyPem) {
        return { valid: false, error: "Server misconfigured: missing JWT_PUBLIC_KEY" };
      }
      key = await importSPKI(publicKeyPem.replace(/\\n/g, "\n"), "RS256");
    } else {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return { valid: false, error: "Server misconfigured: missing JWT_SECRET" };
      }
      key = new TextEncoder().encode(secret);
    }

    const verifyOptions: any = { algorithms: [algorithm] };
    if (process.env.JWT_ISSUER) verifyOptions.issuer = process.env.JWT_ISSUER;
    if (process.env.JWT_AUDIENCE) verifyOptions.audience = process.env.JWT_AUDIENCE;

    const { payload } = await jwtVerify(token, key, verifyOptions);
    return { valid: true, payload: payload as Record<string, any> };
  } catch (err: any) {
    return { valid: false, error: `JWT verification failed: ${err.message}` };
  }
}
