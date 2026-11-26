# Experimental features

Code for features that are being tried before everyone gets them. Only ReelForge Experimental, built with `--mode experimental`, includes anything from this folder. See **Experimental features** in the [README](../../README.md) for how that app is built and downloaded.

- The rest of the app reaches this folder only through `import { experimental } from '@experimental'`. `vite.config.ts` points that at `index.ts` in the experimental build and at `off.ts` in every other build, and stops any other build that would include a file from here.
- To add a feature, put its code here and list it in `features.ts`, which the Experimental features sheet shows. If the rest of the app needs a way in, such as a button on a screen, add a slot to `Experimental` in `types.ts`. Fill the slot in `index.ts` and leave it empty (`null`) in `off.ts`, then check for it where it's used, like `HomeButton` in `src/ui/Home.tsx`.
- Styles go in a stylesheet imported from here, like `experimental.css`, so they stay out of the public build. Use the theme tokens from `src/styles.css`, and write any corner radius of 5px or more as `calc(Npx * var(--rs))`.
- Try it locally with `npm run dev:experimental`.
- When a feature is ready for everyone, move it out of this folder and take it out of `features.ts`.
