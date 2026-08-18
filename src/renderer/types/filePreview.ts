export interface FilePreviewFocusTarget {
  requestId: number;
  lineNumber: number;
  query?: string;
  highlights?: [number, number][];
}
