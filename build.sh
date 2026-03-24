set -euo pipefail

yarn install --frozen-lockfile;
yarn run vite:build;
hugo --minify;
