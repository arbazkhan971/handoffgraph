package commands

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/webui"
)

// RegisterWebUICmd registers the `open` command, which serves the v0.5.0
// local session debugger web UI. The server binds 127.0.0.1 only; it is
// never exposed on other interfaces.
func RegisterWebUICmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "open",
		Summary: "Serve the local session debugger web UI (localhost only)",
		Usage:   "[--port N]",
		Flags: func(fs *flag.FlagSet) {
			fs.Int("port", webui.DefaultPort, "localhost port to listen on (0 picks a free port)")
		},
		Run: webUICmd,
	})
}

// webUIPortFlag reads the --port int flag following the same lookup pattern
// as boolFlag/stringFlag in flags.go. It lives here (not in flags.go) so
// this file stays self-contained.
func webUIPortFlag(fs *flag.FlagSet) int {
	f := fs.Lookup("port")
	if f == nil {
		return webui.DefaultPort
	}
	g, ok := f.Value.(flag.Getter)
	if !ok {
		return webui.DefaultPort
	}
	v, ok := g.Get().(int)
	if !ok {
		return webui.DefaultPort
	}
	return v
}

func webUICmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	port := webUIPortFlag(fs)
	if port < 0 || port > 65535 {
		return fmt.Errorf("open: --port must be between 0 and 65535, got %d", port)
	}

	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	httpSrv := &http.Server{Handler: webui.New(db).Handler()}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("open: listen on %s: %w", addr, err)
	}
	url := fmt.Sprintf("http://%s/", ln.Addr().String())
	fmt.Fprintf(c.Stdout, "handoffgraph session debugger: %s\n", url)
	fmt.Fprintln(c.Stdout, "listening on localhost only — press Ctrl-C to stop")

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("open: shutdown: %w", err)
		}
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("open: serve: %w", err)
	}
}
