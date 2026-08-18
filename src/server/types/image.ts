export interface InlineImagePayload {
  kind?: 'inline_base64';
  id?: string;
  name: string;
  mimeType: string;
  data: string;
  sizeBytes?: number;
}

export interface AttachmentRefImagePayload {
  kind: 'attachment_ref';
  id?: string;
  name: string;
  mimeType: string;
  relativePath: string;
  sizeBytes?: number;
}

export type ImagePayload = InlineImagePayload | AttachmentRefImagePayload;
export type ResolvedImagePayload = InlineImagePayload & { data: string };

export function isAttachmentRefImagePayload(
  image: ImagePayload,
): image is AttachmentRefImagePayload {
  return image.kind === 'attachment_ref';
}

export function isInlineImagePayload(image: ImagePayload): image is InlineImagePayload {
  return typeof (image as { data?: unknown }).data === 'string';
}

