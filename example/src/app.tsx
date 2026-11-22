import "./app.css";

import { Meta, MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { styled } from "@style-this/solid";
import { Suspense } from "solid-js";
import Main from "~/Main";
import { color } from "~/theme";
import UpdateRequired from "~/UpdateRequired";

export default function App() {
  return (
    <MetaProvider>
      <Router
        root={(props) => (
          <Root>
            <Title>Test</Title>
            <Meta name="description" content="test app" />
            <Suspense>{props.children}</Suspense>
            <UpdateRequired />
          </Root>
        )}
      >
        {[{ path: "*", component: Main }]}
      </Router>
    </MetaProvider>
  );
}

const Root = styled.div`
  min-height: 100vh;
  color-scheme: dark;
  background-color: ${color.base};
  color: ${color.text};

  ::selection {
    background-color: ${color.surface2};
  }
`;
