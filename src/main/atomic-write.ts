import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** Publishes a complete encoded file with a sibling rename. */
export async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop() ?? "export"}.${randomBytes(6).toString("hex")}.part`,
  );
  await fs.writeFile(temporary, data);
  try {
    await fs.rename(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await fs.rm(path, { force: true });
    await fs.rename(temporary, path);
  }
}
