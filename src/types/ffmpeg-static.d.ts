// ffmpeg-static 5.3.0 advertises types that are absent from its installed package.
declare module "ffmpeg-static" {
  const executablePath: string | null;
  export = executablePath;
}
