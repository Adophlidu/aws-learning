# 构建阶段跑在原生架构(BUILDPLATFORM)，交叉编译到目标架构 → 避开 Apple Silicon 上模拟 amd64 编译器
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0 go build -o /stats-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /stats-service /stats-service
EXPOSE 8080
ENTRYPOINT ["/stats-service"]
