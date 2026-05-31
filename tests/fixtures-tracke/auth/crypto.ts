// Tiny helper kept inside the auth module so the clusterer sees a
// same-directory shared dependency.
export function hashPassword(pw: string): string {
  let h = 0;
  for (let i = 0; i < pw.length; i++) h = (h * 31 + pw.charCodeAt(i)) | 0;
  return String(h);
}
