验证用自签名证书（非密钥材料，专供 verify-container 的 mock OSS TLS 身份；.pem 扩展名被仓库根 .gitignore 的 *.pem 规则挡住，故用 .crt）：
- oss-mock-ca.crt           根 CA（PEM），经 compose 覆盖文件的 NODE_EXTRA_CA_CERTS 注入容器
- oss-mock-server.crt/.key  叶证书（PEM），SAN=verify-bucket.host.docker.internal
有效期至 2046 年；泄露无风险——只签这一个本地验证主机名。
