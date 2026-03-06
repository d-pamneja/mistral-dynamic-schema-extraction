export const dynamic = "force-dynamic";

export default function Home() {
  const health = {
    status: "healthy",
    version: "1.0.0",
    service: "mistral-ocr-executor",
    timestamp: new Date().toISOString(),
  };

  return (
    <pre>{JSON.stringify(health, null, 2)}</pre>
  );
}
