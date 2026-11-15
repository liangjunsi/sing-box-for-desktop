// Run from the sibling sing-box module: go run ../sing-box-for-desktop/scripts/decompile-routing.go INPUT OUTPUT
package main

import (
	"encoding/json"
	"github.com/sagernet/sing-box/common/srs"
	"os"
)

func main() {
	input, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer input.Close()
	rules, err := srs.Read(input, true)
	if err != nil {
		panic(err)
	}
	output, err := os.Create(os.Args[2])
	if err != nil {
		panic(err)
	}
	defer output.Close()
	if err = json.NewEncoder(output).Encode(rules); err != nil {
		panic(err)
	}
}
