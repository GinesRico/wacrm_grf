import { legacyDb } from '@/db/legacy-query'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbAdmin(): any {
  return legacyDb()
}
