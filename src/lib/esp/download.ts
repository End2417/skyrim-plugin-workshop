// Browsers cannot report whether an anchor download reached Android storage.
export function downloadPlugin(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Leave enough time for Android's download manager to consume the URL,
    // including when the browser reports an error after dispatching the click.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}