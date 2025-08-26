@Library('releng-pipeline') _

hugo (
  appName: 'openhwfoundation.org',
  productionDomain: 'openhwfoundation.org',
  build: [
    containerImage: 'eclipsefdn/hugo-node:h0.144.2-n22.14.0',
  ],
  deployment: [
    nginxServerConf: 'config/nginx/default.conf'
  ]
)
