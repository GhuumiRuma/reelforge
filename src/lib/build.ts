/** Which build of the app this is: the commit it was built from, or "dev" when running locally. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' && __BUILD_ID__ ? __BUILD_ID__ : 'dev';
