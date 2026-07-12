FROM golang:1.24-alpine AS build
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /stats-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /stats-service /stats-service
EXPOSE 8080
ENTRYPOINT ["/stats-service"]
