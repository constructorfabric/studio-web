// The profiles a project's saved description declares, read once per view.

import { useEffect, useState } from "react";
import { api } from "./api";
import { type DeclaredProfile, declaredProfiles } from "./product";

/** The saved description's profiles, read from its latest revision; the
 *  profiles a new description starts with until it is read, and when the
 *  project has none. */
export function useDeclaredProfiles(token: string, projectId: string): DeclaredProfile[] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .productDescription(token, projectId)
      .then((d) => live && setText(d.latest?.text ?? null))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [token, projectId]);
  return declaredProfiles(text);
}

/** The same, read once, for an action that needs it now. */
export async function readDeclaredProfiles(token: string, projectId: string): Promise<DeclaredProfile[]> {
  const d = await api.productDescription(token, projectId).catch(() => null);
  return declaredProfiles(d?.latest?.text ?? null);
}
