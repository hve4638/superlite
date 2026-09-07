# Third-party components

## tmux (bundled binary `daemon/tmux-linux-x86_64`)

Superlite bundles a statically linked tmux binary as its terminal server
(ticket term-list-reconnect). The binary is the unmodified release artifact
`tmux.linux-amd64.gz` from https://github.com/mjakob-gh/build-static-tmux
(build script: MIT). It links the following components statically:

- tmux — ISC License. Copyright (c) 2007 Nicholas Marriott and contributors.
  https://github.com/tmux/tmux/blob/master/COPYING
- libevent — BSD 3-Clause License. Copyright (c) 2000-2007 Niels Provos,
  2007-2012 Niels Provos and Nick Mathewson. https://libevent.org/LICENSE.txt
- ncurses — MIT-style license (X11). Copyright (c) 1998-2024 Free Software
  Foundation, Inc. https://invisible-island.net/ncurses/ncurses-license.html
- musl libc — MIT License. Copyright (c) 2005-2020 Rich Felker et al.
  https://git.musl-libc.org/cgit/musl/tree/COPYRIGHT

The permission notices above apply to the bundled binary. Superlite itself
does not modify tmux; user configuration is layered through a separate
tmux.conf.
