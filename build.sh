set -euo pipefail

yarn install --frozen-lockfile;
yarn run build;
hugo --minify;
