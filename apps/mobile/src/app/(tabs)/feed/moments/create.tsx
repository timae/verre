// Mirror route: moment create (/(tabs)/moments/create) on the FEED stack, for
// your Moments list's "+ New" (lists plan D8): it lands in the new moment on
// this stack. A static sibling of `moments/[id]` (a public id is 12 uppercase
// characters, never `create`); the tabs layout's `/moments/create` suffix
// matcher hides the pill here too.
export { default } from '@/app/(tabs)/moments/create';
