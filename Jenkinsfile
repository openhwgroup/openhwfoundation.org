@Library('releng-pipeline') _

hugo (
  appName: 'openhwfoundation.org',
  productionDomain: 'openhwfoundation.org',
  build: [
    containerImage: 'eclipsefdn/hugo-node:h0.110.0-n18.13.0',
  ],
  deployment: [
    nginxServerConf: 'config/nginx/default.conf'
  ]
)
