import { put } from "@vercel/blob";

export type EvidenceImage = { bytes: Buffer; contentType: "image/jpeg" | "image/png" };

/** Decodes a runner's base64 screenshot and accepts only real JPEG or PNG bytes. */
export function decodeImage(base64: string): EvidenceImage | undefined {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 8) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, contentType: "image/jpeg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, contentType: "image/png" };
  return undefined;
}

export type UploadImage = (pathname: string, image: EvidenceImage) => Promise<string | undefined>;

/** Stores a screenshot in Vercel Blob (public read) and returns its URL, or undefined when no Blob store is connected. */
export const uploadEvidenceImage: UploadImage = async (pathname, image) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return undefined;
  const blob = await put(pathname, image.bytes, {
    access: "public",
    contentType: image.contentType,
    addRandomSuffix: true,
  });
  return blob.url;
};
