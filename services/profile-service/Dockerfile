FROM golang:1.24-alpine AS build
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /profile-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /profile-service /profile-service
EXPOSE 8080
ENTRYPOINT ["/profile-service"]
