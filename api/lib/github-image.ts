/**
 * Helper utility to translate media prefixes.
 */

const swapPrefix = (
  path: string,
  from: string,
  to: string,
  relative = false
) => {
  if (
    path == null
    || from == null
    || to == null
    || (from === to)
    || path.startsWith("//")
    || path.startsWith("http://")
    || path.startsWith("https://")
    || path.startsWith("data:image/")
    || !path.startsWith(from)
  ) return path;
  
  let newPath;
  
  if (from === "" && to !== "/") {
    newPath = `${to}/${path}`;
  } else if (from === "" && to === "/") {
    newPath = `/${path}`;
  } else {
    const remainingPath = path.slice(from.length);
    newPath = to === "/" 
      ? `/${remainingPath.replace(/^\//, '')}` 
      : `${to}/${remainingPath.replace(/^\//, '')}`;
  }

  if (newPath && newPath.startsWith("/") && relative) newPath = newPath.substring(1);

  return newPath;
};

export { swapPrefix };
