/** Request an attachment while keeping the media's existing query parameters. */
export function mediaDownloadUrl(url: string): string {
  const withoutFragment = url.split("#", 1)[0];
  const queryStart = withoutFragment.indexOf("?");
  const path = queryStart < 0 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const query = new URLSearchParams(queryStart < 0 ? "" : withoutFragment.slice(queryStart + 1));
  query.set("download", "1");
  return `${path}?${query}`;
}
