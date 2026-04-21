FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY *.go ./
RUN go build -o fishcast .

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/fishcast .
COPY static/ ./static/
EXPOSE 8080
ENV PORT=8080
CMD ["./fishcast"]
