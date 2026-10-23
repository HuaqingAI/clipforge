/** Browser-safe contracts for the local, generated shot-video library. */
export interface LocalShotVideo {
  id: string;
  projectId: string;
  projectName: string;
  productName: string | null;
  scriptId: string | null;
  scriptTitle: string | null;
  scriptVersion: number | null;
  scriptStyle: string | null;
  shotId: number;
  shotDescription: string | null;
  url: string;
  thumbnailUrl: string | null;
  /** Milliseconds. Null when legacy records did not retain the duration. */
  duration: number | null;
  createdAt: string;
  sizeBytes: number;
  selected: boolean;
  provider: string | null;
  model: string | null;
  fileName: string;
}

export interface DeleteLocalShotVideoResult {
  success: true;
  deletedId: string;
  deletedFiles: number;
  freedBytes: number;
}
