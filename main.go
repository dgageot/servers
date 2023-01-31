package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"

	"github.com/labstack/echo"
	"golang.org/x/sync/errgroup"
)

type server func(ctx context.Context) error

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
	defer cancel()

	if err := runServers(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func runServers(ctx context.Context) error {
	servers := []server{
		startHTTPServer1,
		startHTTPServer2,
	}

	errs, ctx := errgroup.WithContext(ctx)
	for i := range servers {
		sv := servers[i]
		errs.Go(func() error { return sv(ctx) })
	}
	return errs.Wait()
}

var _ = startHTTPServerBAD

func startHTTPServerBAD() error {
	router := echo.New()
	router.GET("/ping", func(e echo.Context) error {
		return e.String(http.StatusOK, "Hello 1")
	})
	go router.Start(":8080")
	return nil
}

func startHTTPServer1(ctx context.Context) error {
	router := echo.New()
	router.GET("/ping", func(e echo.Context) error {
		return e.String(http.StatusOK, "Hello 1")
	})
	go func() {
		<-ctx.Done()
		router.Server.Shutdown(context.Background())
	}()
	return router.Start(":8080")
}

func startHTTPServer2(ctx context.Context) error {
	router := echo.New()
	router.GET("/ping", func(e echo.Context) error {
		return e.String(http.StatusOK, "Hello 2")
	})

	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: "/tmp/server2", Net: "unix"})
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		router.Server.Shutdown(context.Background())
	}()
	if err := router.Server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
